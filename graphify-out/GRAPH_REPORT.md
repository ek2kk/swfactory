# Graph Report - swfactory-pr-integration-20261015  (2026-10-15)

## Corpus Check
- 108 files · ~147,793 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 736 nodes · 2485 edges · 39 communities (36 shown, 3 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 56 edges (avg confidence: 0.77)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `31279253`
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
- main.tsx
- Git Operations and Publication
- Application Setup and Validation
- Process Shutdown and Titles
- TypeScript and Vite Configuration
- Agent Output and Validation
- Artifacts and Conversation Storage
- Build Commits and Source Hashing
- SSE and Results Reset
- dependencies.test.ts
- Model Discovery and Catalogs
- spec.ts
- deletion.test.ts
- app.ts
- Server TypeScript Build
- artifacts.ts
- spec.test.ts
- build.test.ts
- spec.ts
- Chat
- Agent Output Progress
- Учёт наблюдаемых runs
- smoke-github.ts
- TaskView
- theme.ts
- resetResults.test.ts
- resultsReset.ts
- Response

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

## Communities (39 total, 3 thin omitted)

### Community 0 - "Application and Spec Lifecycle"
Cohesion: 0.08
Nodes (15): createApp(), Chat, fetchBase(), preflight(), verifyRepository(), executionSignal(), SpecController, parseTask() (+7 more)

### Community 1 - "Documentation and Agent Workflows"
Cohesion: 0.08
Nodes (44): URL ingestion and file watching, Graph exports and benchmark, Extraction evidence and JSON schema, GitHub cloning and cross-repo graphs, Post-commit graph rebuild hook, Vocabulary constrained graph traversal, Whisper transcription of media, Incremental extraction and graph merge (+36 more)

### Community 2 - "Runtime and Package Dependencies"
Cohesion: 0.05
Nodes (41): better-sqlite3, fastify, @fastify/static, dependencies, better-sqlite3, fastify, @fastify/static, react (+33 more)

### Community 3 - "Review Planning and Shared Types"
Cohesion: 0.16
Nodes (3): ProcessScope, resolveLog(), Titles

### Community 4 - "GitHub Issue Synchronization"
Cohesion: 0.15
Nodes (14): ModelSettings(), AgentOutput(), RunProgress(), makeReviewPlan(), reviewImpact(), ApproveResult, DependencyDiagnostic, Models (+6 more)

### Community 5 - "Codex Execution and Failures"
Cohesion: 0.19
Nodes (18): directory, root, approveSchema, executeSpec, list, nonempty(), reviewSectionSchema, specSchema (+10 more)

### Community 6 - "Dependency Validation and Schemas"
Cohesion: 0.14
Nodes (19): CodexInput, executeResult(), classifyFailure(), CodexFailure, FastModeFailure, prepareFast(), DeliveryError, executeInteractive() (+11 more)

### Community 7 - "Client API and Task Controls"
Cohesion: 0.11
Nodes (26): Api, Composer(), delivery, Message(), RunConversation(), TaskCard(), eventTitles, HistoryItem (+18 more)

### Community 8 - "Scheduling and Process Logging"
Cohesion: 0.18
Nodes (3): TaskMarkdown(), render(), taskCard()

### Community 9 - "main.tsx"
Cohesion: 0.17
Nodes (21): api(), pendingRequests, ArchivedTask(), DependencyStatus(), History(), HumanDecision(), HumanQuestions(), IssueRefresh() (+13 more)

### Community 10 - "Git Operations and Publication"
Cohesion: 0.12
Nodes (8): app(), button(), elements(), hooks(), load(), modal(), render(), submit()

### Community 11 - "Application Setup and Validation"
Cohesion: 0.31
Nodes (7): inspectProject(), remoteIdentity(), Run, pass, ready, settled(), spec

### Community 12 - "Process Shutdown and Titles"
Cohesion: 0.16
Nodes (3): card(), control(), elements()

### Community 13 - "TypeScript and Vite Configuration"
Cohesion: 0.11
Nodes (17): DOM, ES2023, node, src, test, vite.config.ts, compilerOptions, esModuleInterop (+9 more)

### Community 14 - "Agent Output and Validation"
Cohesion: 0.17
Nodes (5): Scheduler, subscribe(), Snapshot, fixture(), Response

### Community 15 - "Artifacts and Conversation Storage"
Cohesion: 0.14
Nodes (26): date(), metric(), number(), RunStatistics(), StatisticsWindow(), TaskStatistics(), Totals(), useClock() (+18 more)

### Community 16 - "Build Commits and Source Hashing"
Cohesion: 0.50
Nodes (3): ModelPicker(), ReasoningPicker(), ModelOption

### Community 17 - "SSE and Results Reset"
Cohesion: 0.11
Nodes (15): githubIssueCommand(), GithubIssues, ImportFailure, ImportLoop, IssueCommand, parseIssue(), GithubIssue, Project (+7 more)

### Community 18 - "dependencies.test.ts"
Cohesion: 0.14
Nodes (19): buildSchema, reviewSchema, ConditionResult, dependenciesSchema, dependencyQuestion(), DiagnoseDependencies, githubLink(), text (+11 more)

### Community 20 - "spec.ts"
Cohesion: 0.29
Nodes (7): repo, execFile, generateText(), generateTitle(), parseTitle(), titleToolRestrictions, Task

### Community 21 - "deletion.test.ts"
Cohesion: 0.21
Nodes (12): saveArtifact(), checkExecution(), context, exec(), ExecutionProcess, processCensus(), ProcessLog, ProcessRow (+4 more)

### Community 22 - "app.ts"
Cohesion: 0.15
Nodes (12): Action, description, equal(), object(), text, uuid, version, VerifyCondition (+4 more)

### Community 23 - "Server TypeScript Build"
Cohesion: 0.22
Nodes (8): src/server, src/shared.ts, ./tsconfig.json, compilerOptions, outDir, rootDir, extends, include

### Community 24 - "artifacts.ts"
Cohesion: 0.29
Nodes (7): artifactDirectory(), readLog(), removeResultArtifacts(), readTranscript(), transcriptEntry(), TranscriptEntry, fixture()

### Community 25 - "spec.test.ts"
Cohesion: 0.24
Nodes (7): readReport(), errorKind(), loggerOptions(), Job, captureLogs(), needsInput, ready

### Community 26 - "build.test.ts"
Cohesion: 0.30
Nodes (11): blocked(), commitBuild(), fileContent(), paths(), safePath(), sourceHash(), ResultsCleanup, BuildResult (+3 more)

### Community 27 - "spec.ts"
Cohesion: 0.26
Nodes (8): classifySpec(), schema, validateDecision(), Problem, SpecDecision, SpecMode, ready, spec

### Community 28 - "Chat"
Cohesion: 0.20
Nodes (7): base, root, executeApprove, executeBuild, executeReview, model, ready

### Community 29 - "Agent Output Progress"
Cohesion: 0.21
Nodes (16): Settings, fixture(), fixture(), fixture(), fixture(), fixture(), fixture(), perform() (+8 more)

### Community 30 - "Учёт наблюдаемых runs"
Cohesion: 0.50
Nodes (3): Семантика CLI, Учёт наблюдаемых runs, Число запусков и время

### Community 34 - "TaskView"
Cohesion: 0.18
Nodes (4): DescriptionDraft, HistoryFlow, Props, TaskView

### Community 35 - "theme.ts"
Cohesion: 0.43
Nodes (4): App(), applyTheme(), readTheme(), Theme

### Community 36 - "resetResults.test.ts"
Cohesion: 0.33
Nodes (4): fixture(), needsInput, projectInput, stageSeed()

### Community 37 - "resultsReset.ts"
Cohesion: 0.50
Nodes (4): applicableReview(), planResultsReset(), ResultsResetPlan, ResultsRestart

## Knowledge Gaps
- **122 isolated node(s):** `name`, `version`, `private`, `type`, `node` (+117 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `createApp()` connect `Application and Spec Lifecycle` to `smoke-github.ts`, `GitHub Issue Synchronization`, `resetResults.test.ts`, `Dependency Validation and Schemas`, `Application Setup and Validation`, `Agent Output and Validation`, `Artifacts and Conversation Storage`, `SSE and Results Reset`, `dependencies.test.ts`, `deletion.test.ts`, `app.ts`, `artifacts.ts`, `spec.test.ts`, `Chat`, `Agent Output Progress`?**
  _High betweenness centrality (0.074) - this node is a cross-community bridge._
- **Why does `Store` connect `Application and Spec Lifecycle` to `Review Planning and Shared Types`, `resetResults.test.ts`, `Codex Execution and Failures`, `GitHub Issue Synchronization`, `Application Setup and Validation`, `Agent Output and Validation`, `Artifacts and Conversation Storage`, `SSE and Results Reset`, `dependencies.test.ts`, `spec.ts`, `deletion.test.ts`, `app.ts`, `artifacts.ts`, `spec.test.ts`, `build.test.ts`, `spec.ts`, `Chat`, `Agent Output Progress`?**
  _High betweenness centrality (0.072) - this node is a cross-community bridge._
- **Why does `AgentRun` connect `Application and Spec Lifecycle` to `GitHub Issue Synchronization`, `resultsReset.ts`, `resetResults.test.ts`, `Client API and Task Controls`, `main.tsx`, `Artifacts and Conversation Storage`, `dependencies.test.ts`, `deletion.test.ts`, `app.ts`, `artifacts.ts`, `build.test.ts`, `spec.ts`?**
  _High betweenness centrality (0.057) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `createApp()` (e.g. with `.run()` and `.events()`) actually correct?**
  _`createApp()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _122 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Application and Spec Lifecycle` be split into smaller, more focused modules?**
  _Cohesion score 0.08460333285856715 - nodes in this community are weakly interconnected._
- **Should `Documentation and Agent Workflows` be split into smaller, more focused modules?**
  _Cohesion score 0.07610993657505286 - nodes in this community are weakly interconnected._