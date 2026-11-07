const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('terminalCanvas', {
    invoke: (action, payload) => ipcRenderer.invoke('terminal:command', action, payload),
    input: (id, data) => ipcRenderer.send('terminal:input', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('terminal:resize', id, cols, rows),
    acknowledge: (id, amount) => ipcRenderer.send('terminal:ack', id, amount),
    onEvent: callback => {
        const listener = (_event, payload) => callback(payload);
        ipcRenderer.on('terminal:event', listener);
        return () => ipcRenderer.removeListener('terminal:event', listener);
    }
});
