# Output format

Write your report as plain markdown, with one heading per finding, in this form:

```
### <Blocker|Major|Nit>: <scope>

<body: what is wrong or missing, why it matters, and what to do about it. Cite paths and line numbers you read.>
```

- The severity is exactly `Blocker`, `Major` or `Nit`. The scope is the section heading, file path or line range the finding is about.
- Put nothing before the first finding except, if your instructions ask for it, the paraphrase in a first `Nit` finding.
- Write no summary, greeting or closing remarks.
- The last line of your report is `Findings: <n>`, where n is the number of headings you wrote. If you found nothing, write only `Findings: 0`.
