const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('nightshift', {
  snapshot: () => ipcRenderer.invoke('app:snapshot'),
  saveSettings: (settings) => ipcRenderer.invoke('app:settings', settings),
  createTask: (task) => ipcRenderer.invoke('app:create-task', task),
  arm: () => ipcRenderer.invoke('app:arm'),
  pause: () => ipcRenderer.invoke('app:pause'),
  stop: () => ipcRenderer.invoke('app:stop'),
  conversation: () => ipcRenderer.invoke('app:conversation'),
  sendMessage: (message) => ipcRenderer.invoke('app:send-message', message),
  answerApproval: (decision, answers) => ipcRenderer.invoke('app:answer-approval', decision, answers),
  acknowledgeBlock: () => ipcRenderer.invoke('app:acknowledge-block'),
  connect: () => ipcRenderer.invoke('app:connect'),
  login: () => ipcRenderer.invoke('app:login'),
  refresh: () => ipcRenderer.invoke('app:refresh'),
  selectProject: () => ipcRenderer.invoke('app:select-project'),
  selectCodex: () => ipcRenderer.invoke('app:select-codex'),
  exportReport: () => ipcRenderer.invoke('app:export-report'),
  openProject: () => ipcRenderer.invoke('app:open-project'),
  onChange: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('app:change', listener);
    return () => ipcRenderer.removeListener('app:change', listener);
  }
});
