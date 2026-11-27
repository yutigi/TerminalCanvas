use std::io::{self, ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, Instant};
use std::{env, fs, thread};

use serde_json::{Value, json};
use tc_core::bridge::{self, Request, Target};
use tc_core::launch;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(100);
const RECEIVE_POLL: Duration = Duration::from_millis(500);

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Input,
    Send,
    Receive,
}

impl Command {
    fn usage(self) -> &'static str {
        match self {
            Self::Input => {
                "tc-hook send-input (--to <card> | --parent) [--text <text> | --stdin] [--enter] [--data-dir <folder>] [--timeout <seconds>] [--json]"
            }
            Self::Send => {
                "tc-hook send-message (--to <card> | --parent) (--text <text> | --stdin) [--timeout <seconds>] [--json]"
            }
            Self::Receive => "tc-hook receive-messages [--wait <seconds>] [--timeout <seconds>] [--json]",
        }
    }
}

struct Options {
    request: Request,
    data_dir: Option<PathBuf>,
    timeout: Duration,
    wait: Duration,
}

struct Failure {
    code: u8,
    status: &'static str,
    error: String,
}

impl Failure {
    fn new(code: u8, status: &'static str, error: impl Into<String>) -> Self {
        Self {
            code,
            status,
            error: error.into(),
        }
    }

    fn usage(error: impl Into<String>) -> Self {
        Self::new(1, "usage", error)
    }
}

pub fn run(command: Command, args: &[String]) -> ExitCode {
    let mut json = false;
    match execute(command, args, &mut json) {
        Ok(None) => {
            println!("usage: {}", command.usage());
            ExitCode::SUCCESS
        }
        Ok(Some(result)) => {
            if json || command == Command::Receive {
                println!("{result}");
            } else {
                let card = result["card"].as_str().unwrap_or_default();
                match command {
                    Command::Input => println!("Terminal input accepted for card {card}."),
                    Command::Send => println!("Message delivered to the mailbox for card {card}."),
                    Command::Receive => unreachable!(),
                }
            }
            ExitCode::SUCCESS
        }
        Err(failure) => {
            if json {
                println!("{}", json!({"status":failure.status,"error":failure.error}));
            } else {
                eprintln!("tc-hook: {}", failure.error);
                if failure.status == "usage" {
                    eprintln!("usage: {}", command.usage());
                }
            }
            ExitCode::from(failure.code)
        }
    }
}

fn parse(command: Command, args: &[String], json: &mut bool) -> Result<Option<Options>, Failure> {
    let sending = command != Command::Receive;
    let mut target = None;
    let mut text = None;
    let mut stdin = false;
    let mut enter = false;
    let mut data_dir = None;
    let mut timeout = DEFAULT_TIMEOUT;
    let mut wait = Duration::ZERO;
    let mut args = args.iter();
    while let Some(flag) = args.next() {
        let mut value = || {
            args.next()
                .ok_or_else(|| Failure::usage(format!("{flag} needs a value.")))
        };
        match flag.as_str() {
            "--help" | "-h" => return Ok(None),
            "--json" => *json = true,
            "--to" if sending && target.is_none() => {
                target = Some(Target {
                    card: Some(value()?.clone()),
                })
            }
            "--parent" if sending && target.is_none() => target = Some(Target { card: None }),
            "--text" if sending && text.is_none() && !stdin => text = Some(value()?.clone()),
            "--stdin" if sending && text.is_none() && !stdin => stdin = true,
            "--enter" if command == Command::Input => enter = true,
            "--data-dir" if command == Command::Input => data_dir = Some(PathBuf::from(value()?)),
            "--timeout" => timeout = duration(flag, value()?)?,
            "--wait" if command == Command::Receive => wait = duration(flag, value()?)?,
            _ => return Err(Failure::usage(format!("Unexpected option {flag:?}."))),
        }
    }
    let request = if sending {
        let target = target.ok_or_else(|| Failure::usage("Specify --to <card ID> or --parent."))?;
        if data_dir.is_some() && target.card.is_none() {
            return Err(Failure::usage("--data-dir requires --to <card ID>."));
        }
        let text = if stdin { read_input()? } else { text.unwrap_or_default() };
        if command == Command::Input {
            Request::SendInput { target, text, enter }
        } else {
            Request::SendMessage { target, text }
        }
    } else {
        Request::ReceiveMessages
    };
    request
        .validate()
        .map_err(|error| Failure::new(2, "refused", error.to_string()))?;
    Ok(Some(Options {
        request,
        data_dir,
        timeout,
        wait,
    }))
}

fn duration(flag: &str, value: &str) -> Result<Duration, Failure> {
    value
        .parse::<u64>()
        .ok()
        .filter(|seconds| (1..=600).contains(seconds))
        .map(Duration::from_secs)
        .ok_or_else(|| Failure::usage(format!("{flag} takes 1 to 600 seconds.")))
}

fn read_input() -> Result<String, Failure> {
    let limit = (bridge::TEXT_UNITS * 4 + crate::UTF8_PREAMBLE.len()) as u64;
    let mut bytes = Vec::new();
    io::stdin()
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| Failure::new(1, "unavailable", format!("Could not read standard input: {error}")))?;
    if bytes.len() as u64 > limit {
        return Err(Failure::new(
            2,
            "refused",
            format!("Text exceeds {} UTF-16 units.", bridge::TEXT_UNITS),
        ));
    }
    let bytes = bytes.strip_prefix(crate::UTF8_PREAMBLE).unwrap_or(&bytes);
    String::from_utf8(bytes.to_vec()).map_err(|_| Failure::usage("Standard input must be UTF-8."))
}

fn destination(options: &Options) -> Result<PathBuf, Failure> {
    if options.data_dir.is_none()
        && let Some(inbox) = env_path(launch::ENV)
    {
        return Ok(inbox);
    }
    if !matches!(
        &options.request,
        Request::SendInput {
            target: Target { card: Some(_) },
            ..
        }
    ) {
        return Err(Failure::new(
            1,
            "unavailable",
            "This command needs the current card's TC_LAUNCH_DIR. Run it inside an integrated Terminal Canvas card with TC_* variables available.",
        ));
    }
    options
        .data_dir
        .clone()
        .or_else(|| env_path(launch::DATA_ENV))
        .or_else(tc_core::dirs::app_data_dir)
        .map(|dir| launch::app_inbox(&dir))
        .ok_or_else(|| {
            Failure::new(
                1,
                "unavailable",
                "The Terminal Canvas data folder is unknown. Pass --data-dir.",
            )
        })
}

fn env_path(key: &str) -> Option<PathBuf> {
    env::var_os(key).filter(|value| !value.is_empty()).map(PathBuf::from)
}

fn execute(command: Command, args: &[String], json: &mut bool) -> Result<Option<Value>, Failure> {
    let Some(options) = parse(command, args, json)? else {
        return Ok(None);
    };
    let inbox = destination(&options)?;
    let deadline = Instant::now() + options.wait;
    loop {
        let result = exchange(&inbox, &options.request, options.timeout)?;
        if command != Command::Receive
            || Instant::now() >= deadline
            || result["messages"]
                .as_array()
                .is_some_and(|messages| !messages.is_empty())
        {
            return Ok(Some(result));
        }
        thread::sleep(RECEIVE_POLL.min(deadline.saturating_duration_since(Instant::now())));
        if Instant::now() >= deadline {
            return Ok(Some(result));
        }
    }
}

fn exchange(inbox: &Path, request: &Request, timeout: Duration) -> Result<Value, Failure> {
    let (id, file) = bridge::write_request(inbox, request).map_err(|error| {
        Failure::new(1, "unavailable", format!("Could not write the bridge request to {}: {error}. Check that the app and this card are running and the request folder is accessible.", inbox.display()))
    })?;
    let deadline = Instant::now() + timeout;
    while file.exists() && Instant::now() < deadline {
        thread::sleep(POLL);
    }
    if launch::withdraw_request(&file) {
        return Err(Failure::new(
            3,
            "timeout",
            "Terminal Canvas did not take the bridge request in time. The request was withdrawn.",
        ));
    }
    let answer = read_answer(&bridge::result_path(inbox, &id), inbox, timeout)?;
    match (request, answer["status"].as_str()) {
        (Request::SendInput { .. }, Some("sent")) | (Request::SendMessage { .. }, Some("delivered"))
            if answer["card"].is_string() =>
        {
            Ok(answer)
        }
        (Request::ReceiveMessages, Some("received")) if answer["messages"].is_array() => Ok(answer),
        (_, Some("refused")) if let Some(error) = answer["error"].as_str() => Err(Failure::new(2, "refused", error)),
        _ => Err(unconfirmed("Terminal Canvas returned an unexpected bridge answer.")),
    }
}

fn read_answer(file: &Path, inbox: &Path, timeout: Duration) -> Result<Value, Failure> {
    let deadline = Instant::now() + timeout;
    loop {
        match fs::File::open(file) {
            Ok(file_handle) => {
                let limit = bridge::REQUEST_BYTES * bridge::MAILBOX_LIMIT as u64;
                let mut bytes = Vec::new();
                let read = file_handle.take(limit + 1).read_to_end(&mut bytes);
                let _ = fs::remove_file(file);
                return read
                    .ok()
                    .filter(|_| bytes.len() as u64 <= limit)
                    .and_then(|_| serde_json::from_slice(&bytes).ok())
                    .ok_or_else(|| unconfirmed("Could not read the Terminal Canvas bridge answer."));
            }
            Err(error) if error.kind() == ErrorKind::NotFound && inbox.is_dir() && Instant::now() < deadline => {}
            Err(_) => {
                return Err(unconfirmed(
                    "Terminal Canvas did not provide a readable bridge answer in time.",
                ));
            }
        }
        thread::sleep(POLL);
    }
}

fn unconfirmed(message: &str) -> Failure {
    Failure::new(
        4,
        "unconfirmed",
        format!("{message} The request may have been applied. Check before retrying."),
    )
}
