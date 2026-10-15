# Graph Report - swfactory-pr96-integration-20261015  (2026-10-15)

## Corpus Check
- 102 files · ~140,726 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 689 nodes · 2336 edges · 25 communities (23 shown, 2 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 46 edges (avg confidence: 0.76)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `37245f40`
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
- Chat and Stage History
- Git Operations and Publication
- Application Setup and Validation
- Process Shutdown and Titles
- TypeScript and Vite Configuration
- Agent Output and Validation
- Artifacts and Conversation Storage
- Build Commits and Source Hashing
- SSE and Results Reset
- Task View and Scroll State
- Model Discovery and Catalogs
- Server TypeScript Build
- Application Theme Settings
- Agent Output Progress

## God Nodes (most connected - your core abstractions)
1. `Store` - 97 edges
2. `createApp()` - 87 edges
3. `AgentRun` - 59 edges
4. `SpecController` - 48 edges
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

## Communities (25 total, 2 thin omitted)

### Community 0 - "Application and Spec Lifecycle"
Cohesion: 0.09
Nodes (17): createApp(), fetchBase(), preflight(), verifyRepository(), checkExecution(), ExecutionProcess, executionSignal(), SpecController (+9 more)

### Community 1 - "Documentation and Agent Workflows"
Cohesion: 0.08
Nodes (44): URL ingestion and file watching, Graph exports and benchmark, Extraction evidence and JSON schema, GitHub cloning and cross-repo graphs, Post-commit graph rebuild hook, Vocabulary constrained graph traversal, Whisper transcription of media, Incremental extraction and graph merge (+36 more)

### Community 2 - "Runtime and Package Dependencies"
Cohesion: 0.05
Nodes (41): better-sqlite3, fastify, @fastify/static, dependencies, better-sqlite3, fastify, @fastify/static, react (+33 more)

### Community 3 - "Review Planning and Shared Types"
Cohesion: 0.08
Nodes (15): errorKind(), loggerOptions(), context, processCensus(), ProcessLog, ProcessRow, ProcessScope, resolveLog() (+7 more)

### Community 4 - "GitHub Issue Synchronization"
Cohesion: 0.14
Nodes (19): ModelSettings(), applicableReview(), planResultsReset(), ResultsResetPlan, ResultsRestart, makeReviewPlan(), reviewImpact(), ResultsCleanup (+11 more)

### Community 5 - "Codex Execution and Failures"
Cohesion: 0.05
Nodes (82): base, root, directory, root, repo, blocked(), commitBuild(), fileContent() (+74 more)

### Community 6 - "Dependency Validation and Schemas"
Cohesion: 0.21
Nodes (16): Settings, fixture(), fixture(), fixture(), application(), repository(), until(), fixture() (+8 more)

### Community 7 - "Client API and Task Controls"
Cohesion: 0.15
Nodes (26): api(), pendingRequests, Composer(), ArchivedTask(), DependencyStatus(), History(), HumanDecision(), HumanQuestions() (+18 more)

### Community 8 - "Scheduling and Process Logging"
Cohesion: 0.18
Nodes (3): TaskMarkdown(), render(), taskCard()

### Community 9 - "Chat and Stage History"
Cohesion: 0.13
Nodes (18): Api, delivery, Message(), RunConversation(), eventTitles, HistoryItem, stageNames, stageStatus() (+10 more)

### Community 10 - "Git Operations and Publication"
Cohesion: 0.15
Nodes (8): app(), button(), elements(), hooks(), load(), modal(), render(), submit()

### Community 11 - "Application Setup and Validation"
Cohesion: 0.06
Nodes (35): headers, Action, description, equal(), object(), text, uuid, version (+27 more)

### Community 12 - "Process Shutdown and Titles"
Cohesion: 0.22
Nodes (3): card(), control(), elements()

### Community 13 - "TypeScript and Vite Configuration"
Cohesion: 0.11
Nodes (17): DOM, ES2023, node, src, test, vite.config.ts, compilerOptions, esModuleInterop (+9 more)

### Community 14 - "Agent Output and Validation"
Cohesion: 0.31
Nodes (4): subscribe(), Snapshot, fixture(), Response

### Community 15 - "Artifacts and Conversation Storage"
Cohesion: 0.21
Nodes (8): ModelCatalogs, normalizeModels(), defaultModels, ModelCatalog, roles, model, ready, models

### Community 16 - "Build Commits and Source Hashing"
Cohesion: 0.50
Nodes (3): ModelPicker(), ReasoningPicker(), ModelOption

### Community 17 - "SSE and Results Reset"
Cohesion: 0.11
Nodes (15): githubIssueCommand(), GithubIssues, ImportFailure, ImportLoop, IssueCommand, parseIssue(), GithubIssue, Project (+7 more)

### Community 18 - "Task View and Scroll State"
Cohesion: 0.18
Nodes (4): DescriptionDraft, HistoryFlow, Props, TaskView

### Community 23 - "Server TypeScript Build"
Cohesion: 0.22
Nodes (8): src/server, src/shared.ts, ./tsconfig.json, compilerOptions, outDir, rootDir, extends, include

### Community 25 - "Application Theme Settings"
Cohesion: 0.43
Nodes (4): App(), applyTheme(), readTheme(), Theme

## Knowledge Gaps
- **118 isolated node(s):** `name`, `version`, `private`, `type`, `node` (+113 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `createApp()` connect `Application and Spec Lifecycle` to `Review Planning and Shared Types`, `GitHub Issue Synchronization`, `Codex Execution and Failures`, `Dependency Validation and Schemas`, `Application Setup and Validation`, `Agent Output and Validation`, `Artifacts and Conversation Storage`, `SSE and Results Reset`?**
  _High betweenness centrality (0.077) - this node is a cross-community bridge._
- **Why does `Store` connect `Application and Spec Lifecycle` to `Review Planning and Shared Types`, `GitHub Issue Synchronization`, `Codex Execution and Failures`, `Dependency Validation and Schemas`, `Application Setup and Validation`, `Agent Output and Validation`, `Artifacts and Conversation Storage`, `SSE and Results Reset`, `Agent Output Progress`?**
  _High betweenness centrality (0.073) - this node is a cross-community bridge._
- **Why does `AgentRun` connect `Application and Spec Lifecycle` to `Review Planning and Shared Types`, `GitHub Issue Synchronization`, `Codex Execution and Failures`, `Client API and Task Controls`, `Chat and Stage History`, `Application Setup and Validation`, `Agent Output Progress`?**
  _High betweenness centrality (0.057) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `createApp()` (e.g. with `.run()` and `.events()`) actually correct?**
  _`createApp()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _118 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Application and Spec Lifecycle` be split into smaller, more focused modules?**
  _Cohesion score 0.08604954367666232 - nodes in this community are weakly interconnected._
- **Should `Documentation and Agent Workflows` be split into smaller, more focused modules?**
  _Cohesion score 0.07610993657505286 - nodes in this community are weakly interconnected._