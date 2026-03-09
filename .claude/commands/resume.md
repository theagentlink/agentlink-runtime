# /resume — Show and Resume Incomplete Jobs

Show all in-progress jobs and optionally resume a specific one.

## Steps

1. Read `state.json`
2. Filter jobs with `status: "IN_PROGRESS"`
3. Display as table

## Output Format

```
AgentLink — In-Progress Jobs

┌──────────────────┬──────────────────────┬──────────────────────────────┬──────────────────┐
│ Job ID           │ Current Step         │ Checkpoint                   │ Started          │
├──────────────────┼──────────────────────┼──────────────────────────────┼──────────────────┤
│ job_abc123       │ bid_submitted        │ Waiting for bid acceptance   │ 2 hours ago      │
│ job_def456       │ executing            │ Resume at progress=50        │ 45 min ago       │
└──────────────────┴──────────────────────┴──────────────────────────────┴──────────────────┘

To resume a specific job: /resume job_abc123
To resume all: run node runner/index.js (auto-resumes in-progress jobs first)
```

## If Job ID Provided

If the user runs `/resume {jobId}`:
1. Find job in state.json
2. Read its checkpoint
3. Spawn Task with AGENT_SKILL.md content + checkpoint instructions
4. Monitor and report progress

## If No Jobs

```
No incomplete jobs found. All caught up! ✅
```
