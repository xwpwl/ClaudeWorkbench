// Test script to verify Electron window and renderer
import { app, BrowserWindow } from 'electron';

app.whenReady().then(async () => {
  // Find the existing window
  const windows = BrowserWindow.getAllWindows();
  console.log(`Found ${windows.length} windows`);

  for (const win of windows) {
    console.log(`Window: ${win.getTitle()}, visible: ${win.isVisible()}`);

    // Check renderer console for errors
    const errors = [];
    win.webContents.on('console-message', (_event, level, message) => {
      if (level >= 2) { // 2 = error, 3 = warning
        errors.push(message);
      }
    });

    // Wait a bit for console messages
    await new Promise(resolve => setTimeout(resolve, 2000));

    if (errors.length > 0) {
      console.log('Renderer errors:', errors);
    } else {
      console.log('No renderer errors detected');
    }

    // Check DOM elements
    try {
      const result = await win.webContents.executeJavaScript(`
        const root = document.getElementById('root');
        const hasContent = root && root.children.length > 0;
        const panels = {
          sidebar: !!document.querySelector('[class*="sidebar"]') || !!document.querySelector('[class*="project"]'),
          chat: !!document.querySelector('[class*="chat"]') || !!document.querySelector('[class*="timeline"]'),
          terminal: !!document.querySelector('[class*="terminal"]'),
          statusBar: !!document.querySelector('[class*="status"]'),
        };
        JSON.stringify({ hasContent, panels, childCount: root?.children?.length || 0 });
      `);
      console.log('DOM check:', result);
    } catch (err) {
      console.log('DOM check failed:', err.message);
    }
  }

  app.quit();
});
