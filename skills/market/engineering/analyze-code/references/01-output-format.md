## Output Format

```markdown
## Executive Summary
[2-3 sentences: overall health assessment and key risk areas]

## Health Scores

| Category | Score | Notes |
|----------|-------|-------|
| Correctness Risk | X/10 | [Brief assessment] |
| Type Safety | X/10 | [Brief assessment] |
| Observability | X/10 | [Brief assessment] |
| Test Coverage | X/10 | [Brief assessment] |
| Maintainability | X/10 | [Brief assessment] |

## Recommendations by Priority

### CRITICAL / HIGH / MEDIUM / LOW
- **[Category]** `file.ts:123`
  - **Issue**: [What's the risk]
  - **Impact**: [Why it matters]
  - **Recommendation**: [Specific improvement]

## Technical Debt Inventory
[Items with effort estimates: S/M/L/XL]

## Quick Wins
[High impact, low effort improvements]

## Strengths
[What's done well - preserve good patterns]
```

用户没有指定目标时，分析当前项目里最关键的代码路径，并用实际读取到的文件与行号作为证据。