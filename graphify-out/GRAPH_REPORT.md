# Graph Report - 3d22fe0b-7163-4078-86e4-369f5bd3eaa6  (2026-10-15)

## Corpus Check
- 100 files · ~130,297 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 658 nodes · 2179 edges · 29 communities (24 shown, 5 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 42 edges (avg confidence: 0.75)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `22237e63`
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
- AgentRun
- codex.ts
- spec.ts
- TypeScript and Vite Configuration
- app.ts
- Problem
- artifacts.ts
- SSE and Results Reset
- Task View and Scroll State
- Model Discovery and Catalogs
- Live Connection UI Tests
- Window and Modal Tests
- smoke-github.ts
- Server TypeScript Build
- Task Focus and Dialog Tests
- Application Theme Settings
- Agent Output Progress

## God Nodes (most connected - your core abstractions)
1. `Store` - 92 edges
2. `createApp()` - 86 edges
3. `AgentRun` - 55 edges
4. `SpecController` - 47 edges
5. `saveArtifact()` - 19 edges
6. `GithubIssues` - 18 edges
7. `Problem` - 18 edges
8. `Project` - 18 edges
9. `Run` - 17 edges
10. `ProcessScope` - 16 edges

## Surprising Connections (you probably didn't know these)
- `Issue implementation workflow` --semantically_similar_to--> `Issue implementation workflow`  [INFERRED] [semantically similar]
  AGENTS.md → CLAUDE.md
- `render()` --indirect_call--> `TaskMarkdown()`  [INFERRED]
  test/taskMarkdown.test.ts → src/client/TaskMarkdown.tsx
- `taskCard()` --indirect_call--> `TaskMarkdown()`  [INFERRED]
  test/taskView.test.ts → src/client/TaskMarkdown.tsx
- `fixture()` --calls--> `createApp()`  [EXTRACTED]
  test/projectDeletion.test.ts → src/server/app.ts
- `app()` --indirect_call--> `TaskMarkdown()`  [INFERRED]
  test/windows.test.ts → src/client/TaskMarkdown.tsx

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Requirements to reviewed GitHub publication** — readme_spec_modes, readme_review_plan, readme_github_publication, readme_source_integrity [EXTRACTED 1.00]
- **Independent visibility stop evidence and capacity** — docs_task_deletion_visibility, docs_task_deletion_stop_verification, readme_fifo_scheduler [EXTRACTED 1.00]

## Communities (29 total, 5 thin omitted)

### Community 0 - "Application and Spec Lifecycle"
Cohesion: 0.08
Nodes (27): createApp(), equal(), object(), port, parseTask(), reviewMetadata(), Store, ReviewPlan (+19 more)

### Community 1 - "Documentation and Agent Workflows"
Cohesion: 0.08
Nodes (44): URL ingestion and file watching, Graph exports and benchmark, Extraction evidence and JSON schema, GitHub cloning and cross-repo graphs, Post-commit graph rebuild hook, Vocabulary constrained graph traversal, Whisper transcription of media, Incremental extraction and graph merge (+36 more)

### Community 2 - "Runtime and Package Dependencies"
Cohesion: 0.05
Nodes (41): better-sqlite3, fastify, @fastify/static, dependencies, better-sqlite3, fastify, @fastify/static, react (+33 more)

### Community 3 - "Review Planning and Shared Types"
Cohesion: 0.13
Nodes (20): classifySpec(), schema, validateDecision(), ResultsCleanup, ApproveResult, DependencyDiagnostic, ExecutionPause, legacyReviewRoles (+12 more)

### Community 4 - "GitHub Issue Synchronization"
Cohesion: 0.09
Nodes (18): githubIssueCommand(), GithubIssues, ImportFailure, ImportLoop, IssueCommand, parseIssue(), subscribe(), GithubIssue (+10 more)

### Community 6 - "Dependency Validation and Schemas"
Cohesion: 0.10
Nodes (27): base, root, blocked(), commitBuild(), fileContent(), paths(), safePath(), sourceHash() (+19 more)

### Community 7 - "Client API and Task Controls"
Cohesion: 0.15
Nodes (23): api(), pendingRequests, ArchivedTask(), DependencyStatus(), History(), HumanDecision(), HumanQuestions(), IssueRefresh() (+15 more)

### Community 8 - "Scheduling and Process Logging"
Cohesion: 0.18
Nodes (3): ProcessScope, resolveLog(), Titles

### Community 9 - "Chat and Stage History"
Cohesion: 0.12
Nodes (22): Api, Composer(), delivery, Message(), RunConversation(), TaskCard(), eventTitles, HistoryItem (+14 more)

### Community 10 - "AgentRun"
Cohesion: 0.18
Nodes (8): fetchBase(), preflight(), verifyRepository(), executionSignal(), SpecController, AgentRun, DependencyCheck, perform()

### Community 11 - "codex.ts"
Cohesion: 0.11
Nodes (20): directory, root, approveSchema, executeApprove, executeBuild, executeReview, executeSpec, list (+12 more)

### Community 12 - "spec.ts"
Cohesion: 0.18
Nodes (17): repo, saveArtifact(), DiagnoseDependencies, VerifyCondition, errorKind(), loggerOptions(), checkExecution(), context (+9 more)

### Community 13 - "TypeScript and Vite Configuration"
Cohesion: 0.11
Nodes (17): DOM, ES2023, node, src, test, vite.config.ts, compilerOptions, esModuleInterop (+9 more)

### Community 14 - "app.ts"
Cohesion: 0.19
Nodes (13): Action, description, text, uuid, version, readReport(), inspectProject(), remoteIdentity() (+5 more)

### Community 15 - "Problem"
Cohesion: 0.20
Nodes (8): CodexFailure, DeliveryError, Steer, Problem, FailureKind, RunDiagnostic, ready, ready

### Community 16 - "artifacts.ts"
Cohesion: 0.36
Nodes (5): artifactDirectory(), readLog(), removeResultArtifacts(), readTranscript(), transcriptEntry()

### Community 18 - "Task View and Scroll State"
Cohesion: 0.18
Nodes (4): DescriptionDraft, HistoryFlow, Props, TaskView

### Community 19 - "Model Discovery and Catalogs"
Cohesion: 0.18
Nodes (16): CodexInput, executeResult(), classifyFailure(), FastModeFailure, prepareFast(), executeInteractive(), discoverModels(), ModelCatalogs (+8 more)

### Community 21 - "Window and Modal Tests"
Cohesion: 0.06
Nodes (18): ModelPicker(), ReasoningPicker(), TaskMarkdown(), ModelOption, card(), control(), elements(), Source (+10 more)

### Community 23 - "Server TypeScript Build"
Cohesion: 0.22
Nodes (8): src/server, src/shared.ts, ./tsconfig.json, compilerOptions, outDir, rootDir, extends, include

### Community 25 - "Application Theme Settings"
Cohesion: 0.43
Nodes (4): App(), applyTheme(), readTheme(), Theme

### Community 29 - "Agent Output Progress"
Cohesion: 0.32
Nodes (10): AgentOutput(), RunProgress(), nonempty(), validateApprove(), validateBuild(), validateReview(), validateSpec(), validQuestions() (+2 more)

## Knowledge Gaps
- **115 isolated node(s):** `name`, `version`, `private`, `type`, `node` (+110 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `createApp()` connect `Application and Spec Lifecycle` to `Review Planning and Shared Types`, `GitHub Issue Synchronization`, `Dependency Validation and Schemas`, `AgentRun`, `codex.ts`, `spec.ts`, `app.ts`, `artifacts.ts`, `Model Discovery and Catalogs`, `smoke-github.ts`, `Task Focus and Dialog Tests`?**
  _High betweenness centrality (0.081) - this node is a cross-community bridge._
- **Why does `Store` connect `Application and Spec Lifecycle` to `Review Planning and Shared Types`, `GitHub Issue Synchronization`, `Codex Execution and Failures`, `Dependency Validation and Schemas`, `Scheduling and Process Logging`, `AgentRun`, `codex.ts`, `spec.ts`, `app.ts`, `Problem`, `artifacts.ts`, `SSE and Results Reset`, `Agent Output Progress`?**
  _High betweenness centrality (0.070) - this node is a cross-community bridge._
- **Why does `AgentRun` connect `AgentRun` to `Application and Spec Lifecycle`, `Review Planning and Shared Types`, `Codex Execution and Failures`, `Dependency Validation and Schemas`, `Client API and Task Controls`, `Chat and Stage History`, `spec.ts`, `app.ts`, `Problem`, `artifacts.ts`, `SSE and Results Reset`, `Agent Output Progress`?**
  _High betweenness centrality (0.057) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `createApp()` (e.g. with `.run()` and `.events()`) actually correct?**
  _`createApp()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _115 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Application and Spec Lifecycle` be split into smaller, more focused modules?**
  _Cohesion score 0.07838827838827839 - nodes in this community are weakly interconnected._
- **Should `Documentation and Agent Workflows` be split into smaller, more focused modules?**
  _Cohesion score 0.07610993657505286 - nodes in this community are weakly interconnected._