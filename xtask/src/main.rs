//! Development tasks, run with `cargo xtask <task>`.
//!
//! - `check`: rustfmt, clippy with `-D warnings`, `node --check` on the UI scripts, both test
//!   suites, and the golden fixtures in `--check` mode.
//! - `golden [--check]`: captures the JavaScript host's behavior into `tests/golden/`.
//! - `package [--target <triple>] [--updater]`: this platform's desktop packages, in `release/`.
//! - `package-windows`: the Windows installer and portable zip, without updater signatures.
//! - `release --tag … --repo … --input … --output …`: the GitHub release files and `latest.json`.

use std::path::PathBuf;
use std::process::{Command, ExitCode};

mod icons;
mod package;
mod release;
mod syntax;

const USAGE: &str = "usage: cargo xtask check | syntax | golden [--check] | icons [--check] | package [--target <triple>] [--updater] | package-windows | release --tag <vX.Y.Z> --repo <owner/name> --input <dir> --output <dir> [--date <RFC 3339>]";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("check") => check(),
        Some("syntax") => syntax::check(&root()),
        Some("golden") => golden(args.get(1).is_some_and(|flag| flag == "--check")),
        Some("icons") => icons::run(&root(), args.get(1).is_some_and(|flag| flag == "--check")),
        Some("package") => {
            package::Options::parse(&args[1..]).and_then(|options| package::package(&root(), &cargo(), &options))
        }
        Some("package-windows") => package::package(&root(), &cargo(), &package::Options::windows()),
        Some("release") => release::run(&root(), &args[1..]),
        _ => Err(USAGE.to_owned()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("xtask: {message}");
            ExitCode::FAILURE
        }
    }
}

fn root() -> PathBuf {
    // Cargo may reuse a cached task binary when multiple checkouts share a target directory.
    // Its runtime environment identifies the current invocation, not the binary's old checkout.
    let manifest = std::env::var_os("CARGO_MANIFEST_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    manifest.parent().expect("xtask lives in the workspace").to_path_buf()
}

/// npm is a batch file on Windows.
fn npm() -> &'static str {
    if cfg!(windows) { "npm.cmd" } else { "npm" }
}

fn run(program: &str, args: &[&str]) -> Result<(), String> {
    println!("> {program} {}", args.join(" "));
    let status = Command::new(program)
        .args(args)
        .current_dir(root())
        .status()
        .map_err(|error| format!("could not run {program}: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{program} {} failed ({status})", args.join(" ")))
    }
}

fn cargo() -> String {
    std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_owned())
}

fn check() -> Result<(), String> {
    println!("Checking workspace: {}", root().display());
    let cargo = cargo();
    run(&cargo, &["fmt", "--all", "--check"])?;
    run(
        &cargo,
        &["clippy", "--workspace", "--all-targets", "--", "-D", "warnings"],
    )?;
    run(
        &cargo,
        &[
            "clippy",
            "-p",
            "terminal-canvas",
            "--all-targets",
            "--features",
            "e2e",
            "--",
            "-D",
            "warnings",
        ],
    )?;
    syntax::check(&root())?;
    run(&cargo, &["test", "--workspace"])?;
    run(&cargo, &["test", "-p", "terminal-canvas", "--features", "e2e"])?;
    run(npm(), &["test"])?;
    icons::run(&root(), true)?;
    golden(true)
}

fn golden(check: bool) -> Result<(), String> {
    let mut args = vec!["scripts/capture-golden.cjs"];
    if check {
        args.push("--check");
    }
    run("node", &args)
}
