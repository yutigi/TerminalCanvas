
__tc_agent() {
    local provider="$1"; shift
    local executable session_id="" token previous="" argument code
    executable=$(type -P "$provider")
    if [ -z "$executable" ]; then printf '%s is unavailable. Install it on PATH, or use Start fresh to open a shell.\n' "$provider" >&2; return 127; fi
    token=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)
    export TC_LAUNCH_TOKEN="$token"
    for argument in "$@"; do
        case "$previous" in --resume|-r|--session-id|resume) session_id="$argument";; esac
        previous="$argument"
    done
    local prefix=() extra=()
    if [ "$provider" = claude ]; then
        if [ "$#" -eq 0 ]; then session_id="$token"; extra+=(--session-id "$session_id"); fi
        case " $* " in *' --settings '*|*' --settings='*) ;; *) extra+=(--settings {{SETTINGS}});; esac
    fi
    if [ "$provider" = codex ]; then prefix=(-c {{CODEX_HOOK}}); fi
    "$TC_HOOK" emit launch "$provider" "$session_id"
    "$executable" "${prefix[@]}" "$@" "${extra[@]}"
    code=$?
    "$TC_HOOK" emit end "$code"
    return "$code"
}
claude() { __tc_agent claude "$@"; }
codex() { __tc_agent codex "$@"; }
__tc_cwd() { printf '\033]7;file://localhost%s\007' "$(pwd -P | sed 's/%/%25/g; s/ /%20/g; s/#/%23/g; s/?/%3F/g')"; }
if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a'* ]]; then
    PROMPT_COMMAND=(__tc_cwd "${PROMPT_COMMAND[@]}")
else
    PROMPT_COMMAND="__tc_cwd${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
fi
