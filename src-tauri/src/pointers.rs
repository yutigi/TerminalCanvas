//! Hook-pointer runtime. Only the host actor calls this; all writes use its terminal manager.
use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tc_core::pointers::{Action, Report, ends};
use tc_core::workspace::{Item, Workspace};
use tc_pty::TerminalManager;
use tc_pty::manager::PointerReadiness;

const TTL: Duration = Duration::from_secs(60);
const QUEUE_PER_TARGET: usize = 16;
const QUEUE_TOTAL: usize = 256;

struct Pending {
    item: Item,
    target: String,
    generation: u64,
    identity: String,
    text: String,
    deadline: Instant,
}

#[derive(Default)]
pub struct Pointers {
    queued: VecDeque<Pending>,
    rates: HashMap<String, VecDeque<Instant>>,
    global: VecDeque<Instant>,
    continuations: HashMap<String, (String, u8)>,
    pub launches: HashMap<String, (Item, Instant)>,
}

pub fn status(id: &str, state: &str, message: &str) -> Value {
    json!({"type":"pointer", "id":id, "state":state, "message":message})
}

fn enabled(board: &Workspace, item: &Item) -> bool {
    !board.hooks_paused
        && item.hook.as_ref().is_some_and(|hook| hook.armed)
        && board.items.iter().any(|current| current == item)
}

impl Pointers {
    /// Called after every actor turn, including autosave and poll. Disarm never leaves work behind.
    pub fn reconcile(&mut self, board: &Workspace, manager: &TerminalManager) -> Vec<Value> {
        let now = Instant::now();
        let mut events = Vec::new();
        self.queued.retain(|pending| {
            let keep = enabled(board, &pending.item)
                && pending.deadline > now
                && manager.pointer_generation(&pending.target) == Some(pending.generation)
                && manager.pointer_identity(&pending.target).as_deref() == Some(&pending.identity);
            if !keep {
                events.push(status(
                    &pending.item.id,
                    "failed",
                    "Queued delivery canceled, expired, or target closed.",
                ));
            }
            keep
        });
        self.launches.retain(|_, (item, deadline)| {
            let keep = enabled(board, item) && *deadline > now;
            if !keep {
                events.push(status(&item.id, "failed", "New-terminal action canceled or expired."));
            }
            keep
        });
        self.rates.retain(|id, _| board.items.iter().any(|item| &item.id == id));
        self.continuations.retain(|id, _| manager.is_running(id));
        events
    }

    fn permit(&mut self, id: &str, now: Instant) -> bool {
        self.global.retain(|at| now.duration_since(*at) < TTL);
        let rate = self.rates.entry(id.to_owned()).or_default();
        rate.retain(|at| now.duration_since(*at) < TTL);
        if self.global.len() >= 60
            || rate.len() >= 8
            || rate
                .back()
                .is_some_and(|at| now.duration_since(*at) < Duration::from_secs(1))
        {
            return false;
        }
        rate.push_back(now);
        self.global.push_back(now);
        true
    }

    pub fn fire(
        &mut self,
        board: &Workspace,
        source: &str,
        report: &Report,
        manager: &mut TerminalManager,
    ) -> Vec<Value> {
        let mut events = self.reconcile(board, manager);
        if board.hooks_paused {
            return events;
        }
        for item in &board.items {
            let Some(hook) = &item.hook else {
                continue;
            };
            let Some((from, target)) = ends(item) else {
                continue;
            };
            if from != source || !hook.matches(report) {
                continue;
            }
            if !self.permit(&item.id, Instant::now()) {
                events.push(status(
                    &item.id,
                    "failed",
                    "Pointer rate limit: 1/second, 8/minute; all pointers 60/minute.",
                ));
                continue;
            }
            let text = hook.payload(report);
            if hook.action == Action::NewTerminal {
                let Some(template) = board.cards.iter().find(|card| card.id == target) else {
                    continue;
                };
                if !tc_core::dirs::is_directory(&template.cwd) {
                    events.push(status(
                        &item.id,
                        "failed",
                        "The target template's project folder is unavailable.",
                    ));
                    continue;
                }
                let request = format!("pointer-{}", uuid::Uuid::new_v4());
                self.launches
                    .insert(request.clone(), (item.clone(), Instant::now() + TTL));
                events.push(json!({"type":"launch", "id":source, "request":request, "pointer":item.id,
                    "profile":template.profile, "title":template.title, "cwd":template.cwd, "command":text, "claudeAccount":template.claude_account}));
                events.push(status(
                    &item.id,
                    "queued",
                    "Opening a fresh terminal using the target's profile, name and folder.",
                ));
                continue;
            }
            let prompt = hook.action == Action::Prompt;
            match manager.pointer_readiness(target, prompt) {
                PointerReadiness::Idle => {
                    let data = if prompt {
                        format!("\x1b[200~{text}\x1b[201~\r")
                    } else {
                        format!("{text}\r")
                    };
                    match manager.write(target, &data) {
                        Ok(()) => {
                            manager.pointer_delivered(target, prompt);
                            events.push(status(&item.id, "firing", "Delivered."));
                        }
                        Err(error) => events.push(status(&item.id, "failed", &error.to_string())),
                    }
                }
                PointerReadiness::Busy if prompt => {
                    if self.queued.len() >= QUEUE_TOTAL
                        || self.queued.iter().filter(|pending| pending.target == target).count() >= QUEUE_PER_TARGET
                    {
                        events.push(status(
                            &item.id,
                            "failed",
                            "Target queue is full (16 per target, 256 total).",
                        ));
                    } else {
                        self.queued.push_back(Pending {
                            item: item.clone(),
                            target: target.to_owned(),
                            generation: manager.pointer_generation(target).unwrap_or_default(),
                            identity: manager.pointer_identity(target).unwrap_or_default(),
                            text,
                            deadline: Instant::now() + TTL,
                        });
                        events.push(status(
                            &item.id,
                            "queued",
                            "Waiting for the target's next Stop hook (expires in 60 seconds).",
                        ));
                    }
                }
                state => events.push(status(
                    &item.id,
                    "failed",
                    match state {
                        PointerReadiness::Closed => "Target is closed or stopped.",
                        PointerReadiness::Typing => "Target has user input; automation will not submit it.",
                        _ => {
                            "Target readiness is unknown. Start an integrated shell or enable and trust the CLI hooks."
                        }
                    },
                )),
            }
        }
        events
    }

    /// One queued prompt per Stop. Never type into a running agent; return its continuation JSON.
    pub fn continuation(
        &mut self,
        board: &Workspace,
        target: &str,
        report: &Report,
        manager: &TerminalManager,
    ) -> (Value, Vec<Value>) {
        let mut events = self.reconcile(board, manager);
        let identity = manager.pointer_identity(target).unwrap_or_default();
        if matches!(report.kind.as_str(), "failed" | "interrupt" | "session-end") {
            self.queued.retain(|pending| {
                if pending.target != target {
                    return true;
                }
                events.push(status(
                    &pending.item.id,
                    "failed",
                    "Target interrupted, failed, or ended its session.",
                ));
                false
            });
        }
        if report.kind == "busy" {
            self.continuations.insert(target.into(), (identity.clone(), 0));
        }
        if report.kind != "stop" {
            return (json!({}), events);
        }
        let entry = self.continuations.entry(target.into()).or_insert((identity.clone(), 0));
        if entry.0 != identity {
            *entry = (identity, 0);
        }
        let count = &mut entry.1;
        // A hook already continuing outside this app also consumes the initial continuation slot.
        if report.stop_hook_active && *count == 0 {
            *count = 1;
        }
        if *count >= 8 {
            self.queued.retain(|pending| {
                if pending.target != target {
                    return true;
                }
                events.push(status(
                    &pending.item.id,
                    "failed",
                    "Target reached eight consecutive hook continuations; submit a user prompt to reset.",
                ));
                false
            });
            return (json!({}), events);
        }
        if let Some(index) = self.queued.iter().position(|pending| pending.target == target) {
            let pending = self.queued.remove(index).expect("position exists");
            *count += 1;
            events.push(status(
                &pending.item.id,
                "firing",
                "Delivered through the target's Stop hook.",
            ));
            (json!({"decision":"block", "reason":pending.text}), events)
        } else {
            (json!({}), events)
        }
    }

    pub fn launch_allowed(&self, request: &str, board: &Workspace) -> bool {
        self.launches
            .get(request)
            .is_some_and(|(item, deadline)| *deadline > Instant::now() && enabled(board, item))
    }

    pub fn launch_finished(&mut self, request: &str, error: Option<&str>) -> Option<Value> {
        self.launches.remove(request).map(|(item, _)| {
            status(
                &item.id,
                if error.is_some() { "failed" } else { "firing" },
                error.unwrap_or("Opened a new terminal."),
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;
    use tc_pty::manager::{Backend, Config, EventSink, Process, SessionEvent, SessionKey, SpawnRequest};

    struct TestBackend;
    struct TestProcess;
    impl Process for TestProcess {
        fn pid(&self) -> Option<u32> {
            None
        }
        fn write(&mut self, _: &str) -> io::Result<()> {
            Ok(())
        }
        fn resize(&mut self, _: u16, _: u16) -> io::Result<()> {
            Ok(())
        }
        fn pause(&mut self) {}
        fn resume(&mut self) {}
        fn acknowledge(&mut self, _: usize) {}
        fn kill(&mut self) {}
    }
    impl Backend for TestBackend {
        fn spawn(&mut self, _: &SpawnRequest, _: SessionKey, _: EventSink) -> io::Result<Box<dyn Process>> {
            Ok(Box::new(TestProcess))
        }
        fn watch_directory(&mut self, _: u32, _: tc_core::Platform, _: SessionKey, _: EventSink) -> Box<dyn Send> {
            Box::new(())
        }
    }
    fn fixture(pointers: usize) -> (Workspace, TerminalManager, Report) {
        let mut board = tc_core::workspace::create_workspace().to_value();
        let cwd = std::env::current_dir().unwrap();
        board["cards"] = json!([
            tc_core::workspace::create_card(&json!({"cwd":cwd})).unwrap(),
            tc_core::workspace::create_card(&json!({"cwd":cwd})).unwrap()
        ]);
        board["items"] = Value::Array(
            (0..pointers)
                .map(|i| {
                    json!({"id":format!("p{i}"),"type":"line","arrow":true,
            "start":{"id":board["cards"][0]["id"]},"end":{"id":board["cards"][1]["id"]},
            "hook":{"event":"trigger","action":"prompt","text":format!("prompt {i}"),"armed":true}})
                })
                .collect(),
        );
        let board = tc_core::workspace::validate_workspace(&board).unwrap();
        let mut manager = TerminalManager::new(
            Config::from_environment(),
            Box::new(TestBackend),
            None,
            std::sync::Arc::new(|_, _| {}),
        );
        let target = &board.cards[1].id;
        manager.start(&json!(board.cards[1]), None, None, None).unwrap();
        use base64::Engine;
        let launch = json!({"type":"launch","provider":"claude","token":"abcdef01-1234-4321-9876-123456789abc","sessionId":"12345678-1234-4321-9876-123456789abc","cwd":cwd});
        let key = SessionKey {
            id: target.clone(),
            generation: manager.pointer_generation(target).unwrap(),
        };
        manager.handle(
            key,
            SessionEvent::Output(format!(
                "\x1b]633;TC;{}\x07",
                base64::engine::general_purpose::STANDARD.encode(launch.to_string())
            )),
        );
        let report = Report {
            kind: "trigger".into(),
            token: String::new(),
            provider: String::new(),
            session_id: String::new(),
            message: String::new(),
            name: String::new(),
            exit_code: None,
            stop_hook_active: false,
            expires: 0,
        };
        let mut busy = report.clone();
        busy.kind = "busy".into();
        manager.pointer_lifecycle(target, &busy, false);
        (board, manager, report)
    }

    #[test]
    fn rate_limits_have_a_cooldown_a_pointer_budget_and_a_global_budget() {
        let mut engine = Pointers::default();
        let now = Instant::now();
        assert!(engine.permit("p", now));
        assert!(!engine.permit("p", now));
        for seconds in 1..8 {
            assert!(engine.permit("p", now + Duration::from_secs(seconds)));
        }
        assert!(!engine.permit("p", now + Duration::from_secs(9)));
        assert!(engine.permit("p", now + TTL));
        let mut engine = Pointers::default();
        for i in 0..60 {
            assert!(engine.permit(&format!("p{i}"), now));
        }
        assert!(!engine.permit("next", now));
        assert!(engine.permit("next", now + TTL));
    }

    #[test]
    fn busy_queue_is_bounded_expires_and_caps_consecutive_continuations() {
        let (board, mut manager, mut report) = fixture(17);
        let mut engine = Pointers::default();
        let events = engine.fire(&board, &board.cards[0].id, &report, &mut manager);
        assert_eq!(engine.queued.len(), 16);
        assert_eq!(events.iter().filter(|event| event["state"] == "failed").count(), 1);
        report.kind = "stop".into();
        for i in 0..8 {
            let (answer, _) = engine.continuation(&board, &board.cards[1].id, &report, &manager);
            assert_eq!(answer["reason"], format!("prompt {i}"));
        }
        assert_eq!(
            engine.continuation(&board, &board.cards[1].id, &report, &manager).0,
            json!({})
        );
        assert!(engine.queued.is_empty());
        engine.rates.clear();
        engine.global.clear();
        report.kind = "trigger".into();
        engine.fire(&board, &board.cards[0].id, &report, &mut manager);
        for pending in &mut engine.queued {
            pending.deadline = Instant::now() - Duration::from_secs(1);
        }
        assert_eq!(engine.reconcile(&board, &manager).len(), 16);
        assert!(engine.queued.is_empty());
    }

    #[test]
    fn changed_sessions_and_interruptions_cancel_queued_prompts() {
        let (board, mut manager, mut report) = fixture(1);
        let mut engine = Pointers::default();
        engine.fire(&board, &board.cards[0].id, &report, &mut manager);
        report.kind = "interrupt".into();
        let (_, events) = engine.continuation(&board, &board.cards[1].id, &report, &manager);
        assert_eq!(events[0]["state"], "failed");
        assert!(engine.queued.is_empty());
        engine.rates.clear();
        engine.global.clear();
        report.kind = "trigger".into();
        engine.fire(&board, &board.cards[0].id, &report, &mut manager);
        engine.queued.front_mut().unwrap().identity = "older session".into();
        engine.reconcile(&board, &manager);
        assert!(engine.queued.is_empty());
    }
}
