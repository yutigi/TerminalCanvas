/* Tokens cross only the same-origin login POST and are never saved in browser storage or URLs. */
'use strict';
document.querySelector('#pair-form').addEventListener('submit', async event => {
    event.preventDefault();
    const token = document.querySelector('#pair-token');
    const button = document.querySelector('#pair-submit');
    const error = document.querySelector('#pair-error');
    button.disabled = true; error.textContent = '';
    try {
        const response = await fetch('/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin', body: JSON.stringify({ token: token.value.trim() })
        });
        if (!response.ok) throw new Error(response.status === 429
            ? 'Too many attempts or sessions. Wait a minute, or revoke sessions on the desktop.'
            : 'Connection refused. Check the current token in the desktop app.');
        token.value = '';
        location.replace('/');
    } catch (failure) { error.textContent = failure.message; }
    finally { token.value = ''; button.disabled = false; }
});
