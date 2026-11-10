## Playwright MCP tool reference

**Only use these tools. There is no shell in this project.**

```
# Navigation
mcp__playwright__browser_navigate(url=...)        # Navigate to URL
mcp__playwright__browser_navigate_back()          # Go back
mcp__playwright__browser_close()                  # Close browser

# Snapshots (get element refs)
mcp__playwright__browser_snapshot()               # Interactive elements with refs

# Interactions (use refs from snapshot)
mcp__playwright__browser_click(ref=...)             # Click element
mcp__playwright__browser_fill_form(ref=..., text=...)
mcp__playwright__browser_type(ref=..., text=...)
mcp__playwright__browser_press_key(key=...)
mcp__playwright__browser_wait_for(...)

# Diagnostics
mcp__playwright__browser_console_messages()      # Console errors
mcp__playwright__browser_network_requests()      # Network calls
mcp__playwright__browser_take_screenshot(filename=..., fullPage=true)
```