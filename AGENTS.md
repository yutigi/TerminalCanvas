# Repository Guidelines

## Project Structure & Module Organization

The `TerminalCanvas` directory currently has no source code, tests, assets, dependency manifests, or Git metadata. Update this guide as the implementation takes shape.

When adding the initial implementation, keep application code in `src/`, automated tests in `tests/`, and static resources in `assets/`, unless the selected framework requires another layout. Group code by feature or responsibility, and document entry points and setup in `README.md`.

## Build, Test, and Development Commands

No build, test, or development commands are configured yet. Do not assume commands such as `npm test` or `make build` are available.

When introducing a toolchain, add reproducible commands for dependency installation, local development, production builds, and automated tests. Document the exact commands and required runtime versions in `README.md`; commit the relevant dependency manifest and lockfile.

## Coding Style & Naming Conventions

Follow the chosen language's standard conventions and configure its formatter and linter alongside the first source files. Until then, use four spaces for indentation in code, avoid tabs and trailing whitespace, and keep files focused on one responsibility. Prefer descriptive names and consistent filename casing within each module.

## Testing Guidelines

No test framework or coverage threshold is established. Add tests with new behavior and regression tests with bug fixes. Use descriptive names that identify the behavior and expected result, and mirror source modules under `tests/` where practical. Document the test runner and command when introduced.

## Commit & Pull Request Guidelines

No Git history is available to establish commit conventions. Use concise, imperative commit subjects, such as `Add terminal rendering module`, and keep each commit focused.

Pull requests should describe the change, explain its purpose, link related issues when applicable, and list validation performed. Include screenshots or terminal recordings for visible behavior changes. Explicitly identify checks that could not be run.

## Security & Configuration

Keep credentials, local configuration, generated output, and installed dependencies out of version control. Add appropriate ignore rules and provide sanitized configuration examples when configuration is introduced.
