# Graph Report - a9a3a19a-6276-4be2-b701-05f45879bd9e  (2026-10-15)

## Corpus Check
- 108 files · ~146,174 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 735 nodes · 2474 edges · 30 communities (27 shown, 3 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 55 edges (avg confidence: 0.76)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `6a0ba3bf`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Application and Spec Lifecycle
- Documentation and Agent Workflows
- Runtime and Package Dependencies
- Review Planning and Shared Types
- GitHub Issue Synchronization
- Codex Execution and Failures
- Dependency Validation and Schemas
- Client API and Task Controls
- Scheduling and Process Logging
- Git Operations and Publication
- Application Setup and Validation
- Process Shutdown and Titles
- TypeScript and Vite Configuration
- Agent Output and Validation
- Artifacts and Conversation Storage
- Build Commits and Source Hashing
- SSE and Results Reset
- Model Discovery and Catalogs
- spec.ts
- deletion.test.ts
- app.ts
- Server TypeScript Build
- artifacts.ts
- build.test.ts
- Chat
- Agent Output Progress
- Учёт наблюдаемых runs
- smoke-github.ts

## God Nodes (most connected - your core abstractions)
1. `Store` - 99 edges
2. `createApp()` - 88 edges
3. `AgentRun` - 61 edges
4. `SpecController` - 49 edges
5. `ProcessScope` - 23 edges
6. `saveArtifact()` - 20 edges
7. `GithubIssues` - 18 edges
8. `Problem` - 18 edges
9. `Project` - 18 edges
10. `Run` - 17 edges

## Surprising Connections (you probably didn't know these)
- `Issue implementation workflow` --semantically_similar_to--> `Issue implementation workflow`  [INFERRED] [semantically similar]
  AGENTS.md → CLAUDE.md
- `render()` --indirect_call--> `TaskMarkdown()`  [INFERRED]
  test/taskMarkdown.test.ts → src/client/TaskMarkdown.tsx
- `taskCard()` --indirect_call--> `TaskMarkdown()`  [INFERRED]
  test/taskView.test.ts → src/client/TaskMarkdown.tsx
- `app()` --indirect_call--> `TaskMarkdown()`  [INFERRED]
  test/windows.test.ts → src/client/TaskMarkdown.tsx
- `fixture()` --calls--> `createApp()`  [EXTRACTED]
  test/api.test.ts → src/server/app.ts

## Import Cycles
- 4-file cycle: `src/server/diagnostics.ts -> src/server/store.ts -> src/server/processes.ts -> src/server/logging.ts -> src/server/diagnostics.ts`

## Hyperedges (group relationships)
- **Requirements to reviewed GitHub publication** — readme_spec_modes, readme_review_plan, readme_github_publication, readme_source_integrity [EXTRACTED 1.00]
- **Independent visibility stop evidence and capacity** — docs_task_deletion_visibility, docs_task_deletion_stop_verification, readme_fifo_scheduler [EXTRACTED 1.00]

## Communities (30 total, 3 thin omitted)

### Community 0 - "Application and Spec Lifecycle"
Cohesion: 0.08
Nodes (25): createApp(), port, ExecutionProcess, parseTask(), reviewMetadata(), Store, ExecutionPause, fixture() (+17 more)

### Community 1 - "Documentation and Agent Workflows"
Cohesion: 0.08
Nodes (44): URL ingestion and file watching, Graph exports and benchmark, Extraction evidence and JSON schema, GitHub cloning and cross-repo graphs, Post-commit graph rebuild hook, Vocabulary constrained graph traversal, Whisper transcription of media, Incremental extraction and graph merge (+36 more)

### Community 2 - "Runtime and Package Dependencies"
Cohesion: 0.05
Nodes (41): better-sqlite3, fastify, @fastify/static, dependencies, better-sqlite3, fastify, @fastify/static, react (+33 more)

### Community 3 - "Review Planning and Shared Types"
Cohesion: 0.15
Nodes (4): processCensus(), ProcessScope, resolveLog(), Titles

### Community 4 - "GitHub Issue Synchronization"
Cohesion: 0.11
Nodes (23): ModelSettings(), ModelCatalogs, normalizeModels(), makeReviewPlan(), reviewImpact(), ResultsCleanup, ApproveResult, defaultModels (+15 more)

### Community 5 - "Codex Execution and Failures"
Cohesion: 0.07
Nodes (51): directory, root, AgentOutput(), RunProgress(), approveSchema, buildSchema, CodexInput, executeApprove (+43 more)

### Community 6 - "Dependency Validation and Schemas"
Cohesion: 0.26
Nodes (8): fetchBase(), preflight(), verifyRepository(), checkExecution(), executionSignal(), SpecController, AgentRun, DependencyCheck

### Community 7 - "Client API and Task Controls"
Cohesion: 0.05
Nodes (55): api(), pendingRequests, Api, Composer(), delivery, Message(), RunConversation(), App() (+47 more)

### Community 8 - "Scheduling and Process Logging"
Cohesion: 0.18
Nodes (3): TaskMarkdown(), render(), taskCard()

### Community 10 - "Git Operations and Publication"
Cohesion: 0.14
Nodes (4): button(), elements(), modal(), submit()

### Community 11 - "Application Setup and Validation"
Cohesion: 0.15
Nodes (13): readReport(), inspectProject(), remoteIdentity(), Run, exec(), ProjectInput, SpecResult, fixture() (+5 more)

### Community 12 - "Process Shutdown and Titles"
Cohesion: 0.16
Nodes (3): card(), control(), elements()

### Community 13 - "TypeScript and Vite Configuration"
Cohesion: 0.11
Nodes (17): DOM, ES2023, node, src, test, vite.config.ts, compilerOptions, esModuleInterop (+9 more)

### Community 14 - "Agent Output and Validation"
Cohesion: 0.18
Nodes (4): Scheduler, subscribe(), fixture(), Response

### Community 15 - "Artifacts and Conversation Storage"
Cohesion: 0.13
Nodes (26): date(), metric(), number(), RunStatistics(), StatisticsWindow(), TaskStatistics(), Totals(), useClock() (+18 more)

### Community 17 - "SSE and Results Reset"
Cohesion: 0.15
Nodes (9): githubIssueCommand(), GithubIssues, parseIssue(), Project, syncCard(), github(), issue(), load() (+1 more)

### Community 19 - "Model Discovery and Catalogs"
Cohesion: 0.25
Nodes (5): Source, app(), hooks(), load(), render()

### Community 20 - "spec.ts"
Cohesion: 0.14
Nodes (19): repo, ConditionResult, dependenciesSchema, DiagnoseDependencies, text, VerifyCondition, classifySpec(), schema (+11 more)

### Community 21 - "deletion.test.ts"
Cohesion: 0.18
Nodes (12): saveArtifact(), errorKind(), loggerOptions(), context, ProcessLog, ProcessRow, publishGithub(), Job (+4 more)

### Community 22 - "app.ts"
Cohesion: 0.13
Nodes (15): Action, description, equal(), object(), text, uuid, version, chooseProjectFolder() (+7 more)

### Community 23 - "Server TypeScript Build"
Cohesion: 0.22
Nodes (8): src/server, src/shared.ts, ./tsconfig.json, compilerOptions, outDir, rootDir, extends, include

### Community 24 - "artifacts.ts"
Cohesion: 0.23
Nodes (8): artifactDirectory(), readLog(), removeResultArtifacts(), Problem, readTranscript(), transcriptEntry(), TranscriptEntry, fixture()

### Community 26 - "build.test.ts"
Cohesion: 0.28
Nodes (11): base, root, blocked(), commitBuild(), fileContent(), paths(), safePath(), sourceHash() (+3 more)

### Community 29 - "Agent Output Progress"
Cohesion: 0.25
Nodes (7): ReviewResult, approved(), pass, ready, settled(), spec, visualResult()

### Community 30 - "Учёт наблюдаемых runs"
Cohesion: 0.50
Nodes (3): Семантика CLI, Учёт наблюдаемых runs, Число запусков и время

## Knowledge Gaps
- **123 isolated node(s):** `name`, `version`, `private`, `type`, `node` (+118 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `createApp()` connect `Application and Spec Lifecycle` to `smoke-github.ts`, `GitHub Issue Synchronization`, `Codex Execution and Failures`, `Dependency Validation and Schemas`, `Application Setup and Validation`, `Agent Output and Validation`, `Artifacts and Conversation Storage`, `SSE and Results Reset`, `deletion.test.ts`, `app.ts`, `artifacts.ts`?**
  _High betweenness centrality (0.074) - this node is a cross-community bridge._
- **Why does `Store` connect `Application and Spec Lifecycle` to `Review Planning and Shared Types`, `GitHub Issue Synchronization`, `Codex Execution and Failures`, `Dependency Validation and Schemas`, `Application Setup and Validation`, `Agent Output and Validation`, `Artifacts and Conversation Storage`, `SSE and Results Reset`, `spec.ts`, `deletion.test.ts`, `app.ts`, `artifacts.ts`, `build.test.ts`, `Chat`, `Agent Output Progress`?**
  _High betweenness centrality (0.072) - this node is a cross-community bridge._
- **Why does `AgentRun` connect `Dependency Validation and Schemas` to `Application and Spec Lifecycle`, `GitHub Issue Synchronization`, `Codex Execution and Failures`, `Client API and Task Controls`, `Application Setup and Validation`, `Artifacts and Conversation Storage`, `spec.ts`, `deletion.test.ts`, `app.ts`, `artifacts.ts`, `build.test.ts`, `Chat`?**
  _High betweenness centrality (0.058) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `createApp()` (e.g. with `.run()` and `.events()`) actually correct?**
  _`createApp()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _123 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Application and Spec Lifecycle` be split into smaller, more focused modules?**
  _Cohesion score 0.07824100513992005 - nodes in this community are weakly interconnected._
- **Should `Documentation and Agent Workflows` be split into smaller, more focused modules?**
  _Cohesion score 0.07610993657505286 - nodes in this community are weakly interconnected._