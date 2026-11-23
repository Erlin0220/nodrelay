export const profiles = {
  probe: { path: '/probe/mcp', tools: ['open_workspace', 'read'] },
  development: {
    path: '/devspace/mcp', port: 7829,
    tools: ['open_workspace', 'read', 'apply_patch', 'exec_command', 'write_stdin'],
  },
  browser: {
    path: '/browser/mcp', port: 7831,
    tools: ['browser_profiles', 'browser_navigate', 'browser_snapshot', 'browser_tabs', 'browser_click'],
    optional: [
      'browser_navigate_back', 'browser_hover', 'browser_press_key', 'browser_type', 'browser_fill_form',
      'browser_select_option', 'browser_wait_for', 'browser_take_screenshot',
    ],
  },
};
