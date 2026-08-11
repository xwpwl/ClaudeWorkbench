// Verify Electron UI elements
import { app, BrowserWindow, ipcMain } from 'electron';

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    console.error('No window found');
    app.quit();
    process.exit(1);
  }

  console.log('Window title:', win.getTitle());
  console.log('Window visible:', win.isVisible());
  console.log('Window size:', win.getSize());

  // Wait for renderer to fully load
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Check DOM elements
  try {
    const result = await win.webContents.executeJavaScript(`
      (function() {
        const checks = {};
        const root = document.getElementById('root');
        checks.rootHasChildren = root && root.children.length > 0;
        checks.rootChildCount = root?.children?.length || 0;

        // Check for text content that indicates panels
        const body = document.body.innerText;
        checks.hasWelcomeText = body.includes('Welcome') || body.includes('Claude Workbench');
        checks.hasOpenProject = body.includes('Open Project') || body.includes('project');
        checks.hasSettings = body.includes('Settings') || body.includes('settings');
        checks.hasTerminal = body.includes('Terminal') || body.includes('terminal');
        checks.hasFileChanges = body.includes('File Changes') || body.includes('file');

        // Check for specific elements
        const allText = document.body.innerHTML;
        checks.hasSidebarClass = allText.includes('sidebar') || allText.includes('Sidebar');
        checks.hasChatClass = allText.includes('chat') || allText.includes('Chat') || allText.includes('timeline');
        checks.hasTerminalClass = allText.includes('terminal') || allText.includes('Terminal');
        checks.hasStatusBarClass = allText.includes('StatusBar') || allText.includes('status');

        // Check button count
        const buttons = document.querySelectorAll('button');
        checks.buttonCount = buttons.length;

        // Check input elements
        const inputs = document.querySelectorAll('input, textarea');
        checks.inputCount = inputs.length;

        return JSON.stringify(checks, null, 2);
      })();
    `);
    console.log('UI Verification Result:');
    console.log(result);
  } catch (err) {
    console.error('Failed to check DOM:', err.message);
  }

  // Check IPC - try to list projects
  try {
    const projects = await win.webContents.executeJavaScript(`
      window.api.listProjects()
    `);
    console.log('Projects from IPC:', JSON.stringify(projects));
  } catch (err) {
    console.error('IPC listProjects failed:', err.message);
  }

  // Check environment
  try {
    const env = await win.webContents.executeJavaScript(`
      window.api.checkEnvironment()
    `);
    console.log('Environment check:', JSON.stringify(env, null, 2));
  } catch (err) {
    console.error('IPC checkEnvironment failed:', err.message);
  }

  app.quit();
});
