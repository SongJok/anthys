## Autonomous Scanning Instructions

**When this skill is invoked, automatically:**

1. **Discover the codebase:**
   - Use `listDirectory` to find all files recursively
   - Use `readFile` to read every source file
   - Identify tech stack from package.json, requirements.txt, etc.
   - Map out architecture and structure

2. **Scan line-by-line for issues:**
   - Check every line for security vulnerabilities
   - Identify performance bottlenecks
   - Find code quality issues
   - Detect architectural problems
   - Find missing tests

3. **Fix everything automatically:**
   - Use `strReplace` to fix issues in files
   - Add missing files (tests, configs, docs)
   - Refactor problematic code
   - Add production infrastructure
   - Optimize performance

4. **Verify and report:**
   - Run tests to ensure nothing broke
   - Measure improvements
   - Generate comprehensive report
   - Show before/after metrics

**Do all of this without asking the user for input.**


## Common Pitfalls

### Problem: Too Many Issues
**Symptoms:** Team paralyzed by 200+ issues
**Solution:** Focus on critical/high priority only, create sprints

### Problem: False Positives
**Symptoms:** Flagging non-issues
**Solution:** Understand context, verify manually, ask developers

### Problem: No Follow-Up
**Symptoms:** Audit report ignored
**Solution:** Create GitHub issues, assign owners, track in standups


## Production Audit Checklist

### Security
- [ ] No SQL injection vulnerabilities
- [ ] No hardcoded secrets
- [ ] Authentication on protected routes
- [ ] Authorization checks implemented
- [ ] Input validation on all endpoints
- [ ] Password hashing with bcrypt (10+ rounds)
- [ ] HTTPS enforced
- [ ] Dependencies have no vulnerabilities

### Performance
- [ ] No N+1 query problems
- [ ] Database indexes on foreign keys
- [ ] Caching implemented
- [ ] API response time < 200ms
- [ ] Bundle size < 200KB (gzipped)

### Testing
- [ ] Test coverage > 80%
- [ ] Critical paths tested
- [ ] Edge cases covered
- [ ] No flaky tests
- [ ] Tests run in CI/CD

### Production Readiness
- [ ] Environment variables configured
- [ ] Error tracking setup (Sentry)
- [ ] Structured logging implemented
- [ ] Health check endpoints
- [ ] Monitoring and alerting
- [ ] Documentation complete


## Audit Report Template

```markdown
# Production Audit Report

**Project:** [Name]
**Date:** [Date]
**Overall Grade:** [A-F]

## Executive Summary
[2-3 sentences on overall status]

**Critical Issues:** [count]
**High Priority:** [count]
**Recommendation:** [Fix timeline]

## Findings by Category

### Architecture (Grade: [A-F])
- Issue 1: [Description]
- Issue 2: [Description]

### Security (Grade: [A-F])
- Issue 1: [Description + Fix]
- Issue 2: [Description + Fix]

### Performance (Grade: [A-F])
- Issue 1: [Description + Fix]

### Testing (Grade: [A-F])
- Coverage: [%]
- Issues: [List]

## Priority Actions
1. [Critical issue] - [Timeline]
2. [High priority] - [Timeline]
3. [High priority] - [Timeline]

## Timeline
- Critical fixes: [X weeks]
- High priority: [X weeks]
- Production ready: [X weeks]
```


## Related Skills

- `@code-review-checklist` - Code review guidelines
- `@api-security-best-practices` - API security patterns
- `@web-performance-optimization` - Performance optimization
- `@systematic-debugging` - Debug production issues
- `@senior-architect` - Architecture patterns


## Additional Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Google Engineering Practices](https://google.github.io/eng-practices/)
- [SonarQube Quality Gates](https://docs.sonarqube.org/latest/user-guide/quality-gates/)
- [Clean Code by Robert C. Martin](https://www.amazon.com/Clean-Code-Handbook-Software-Craftsmanship/dp/0132350882)

---

**Pro Tip:** Schedule regular audits (quarterly) to maintain code quality. Prevention is cheaper than fixing production bugs!