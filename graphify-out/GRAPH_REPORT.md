# Graph Report - ae574043-a275-471b-8763-14732a2f66d0  (2026-10-15)

## Corpus Check
- 99 files · ~133,807 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 664 nodes · 2238 edges · 32 communities (28 shown, 4 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 45 edges (avg confidence: 0.76)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `8b7af15e`
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
- deletion.test.ts
- Git Operations and Publication
- Application Setup and Validation
- Process Shutdown and Titles
- TypeScript and Vite Configuration
- Agent Output and Validation
- Artifacts and Conversation Storage
- Build Commits and Source Hashing
- SSE and Results Reset
- TaskView
- windows.test.ts
- Live Connection UI Tests
- Snapshot
- Server TypeScript Build
- theme.ts
- TaskMarkdown
- reviewPlan.ts
- GitHub Smoke Checks
- Source
- Agent Output Progress

## God Nodes (most connected - your core abstractions)
1. `Store` - 94 edges
2. `createApp()` - 85 edges
3. `AgentRun` - 56 edges
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
- `taskCard()` --indirect_call--> `TaskMarkdown()`  [INFERRED]
  test/taskView.test.ts → src/client/TaskMarkdown.tsx
- `app()` --indirect_call--> `TaskMarkdown()`  [INFERRED]
  test/windows.test.ts → src/client/TaskMarkdown.tsx
- `fixture()` --calls--> `createApp()`  [EXTRACTED]
  test/api.test.ts → src/server/app.ts
- `apiFixture()` --calls--> `createApp()`  [EXTRACTED]
  test/deletion.test.ts → src/server/app.ts

## Import Cycles
- 4-file cycle: `src/server/diagnostics.ts -> src/server/store.ts -> src/server/processes.ts -> src/server/logging.ts -> src/server/diagnostics.ts`

## Hyperedges (group relationships)
- **Requirements to reviewed GitHub publication** — readme_spec_modes, readme_review_plan, readme_github_publication, readme_source_integrity [EXTRACTED 1.00]
- **Independent visibility stop evidence and capacity** — docs_task_deletion_visibility, docs_task_deletion_stop_verification, readme_fifo_scheduler [EXTRACTED 1.00]

## Communities (32 total, 4 thin omitted)

### Community 0 - "Application and Spec Lifecycle"
Cohesion: 0.08
Nodes (34): createApp(), saveArtifact(), fetchBase(), preflight(), verifyRepository(), checkExecution(), executionSignal(), publishGithub() (+26 more)

### Community 1 - "Documentation and Agent Workflows"
Cohesion: 0.08
Nodes (44): URL ingestion and file watching, Graph exports and benchmark, Extraction evidence and JSON schema, GitHub cloning and cross-repo graphs, Post-commit graph rebuild hook, Vocabulary constrained graph traversal, Whisper transcription of media, Incremental extraction and graph merge (+36 more)

### Community 2 - "Runtime and Package Dependencies"
Cohesion: 0.05
Nodes (41): better-sqlite3, fastify, @fastify/static, dependencies, better-sqlite3, fastify, @fastify/static, react (+33 more)

### Community 3 - "Review Planning and Shared Types"
Cohesion: 0.12
Nodes (21): inspectProject(), remoteIdentity(), Run, exec(), ResultsCleanup, ApproveResult, ReviewResult, Revision (+13 more)

### Community 4 - "GitHub Issue Synchronization"
Cohesion: 0.25
Nodes (4): GithubIssues, Project, syncCard(), load()

### Community 5 - "Codex Execution and Failures"
Cohesion: 0.06
Nodes (68): directory, root, repo, approveSchema, buildSchema, CodexInput, executeApprove, executeBuild (+60 more)

### Community 6 - "Dependency Validation and Schemas"
Cohesion: 0.28
Nodes (11): base, root, blocked(), commitBuild(), fileContent(), paths(), safePath(), sourceHash() (+3 more)

### Community 7 - "Client API and Task Controls"
Cohesion: 0.13
Nodes (19): Api, Composer(), delivery, Message(), RunConversation(), TaskCard(), eventTitles, HistoryItem (+11 more)

### Community 8 - "Scheduling and Process Logging"
Cohesion: 0.19
Nodes (19): api(), ArchivedTask(), DependencyStatus(), History(), HumanDecision(), HumanQuestions(), IssueRefresh(), labels (+11 more)

### Community 9 - "deletion.test.ts"
Cohesion: 0.20
Nodes (8): readReport(), loggerOptions(), Job, apiFixture(), projectInput, captureLogs(), needsInput, ready

### Community 11 - "Application Setup and Validation"
Cohesion: 0.12
Nodes (12): headers, Action, description, equal(), object(), text, uuid, version (+4 more)

### Community 12 - "Process Shutdown and Titles"
Cohesion: 0.13
Nodes (5): ExecutionProcess, processCensus(), ProcessScope, resolveLog(), Titles

### Community 13 - "TypeScript and Vite Configuration"
Cohesion: 0.11
Nodes (17): DOM, ES2023, node, src, test, vite.config.ts, compilerOptions, esModuleInterop (+9 more)

### Community 14 - "Agent Output and Validation"
Cohesion: 0.19
Nodes (10): githubIssueCommand(), ImportFailure, ImportLoop, IssueCommand, parseIssue(), GithubIssue, issue(), projectInput (+2 more)

### Community 15 - "Artifacts and Conversation Storage"
Cohesion: 0.29
Nodes (7): artifactDirectory(), readLog(), removeResultArtifacts(), readTranscript(), transcriptEntry(), TranscriptEntry, projectInput

### Community 16 - "Build Commits and Source Hashing"
Cohesion: 0.29
Nodes (7): discoverModels(), ModelCatalogs, normalizeModels(), defaultModels, ModelCatalog, roles, models

### Community 18 - "TaskView"
Cohesion: 0.18
Nodes (4): DescriptionDraft, HistoryFlow, Props, TaskView

### Community 19 - "windows.test.ts"
Cohesion: 0.27
Nodes (7): app(), button(), elements(), hooks(), load(), modal(), submit()

### Community 20 - "Live Connection UI Tests"
Cohesion: 0.22
Nodes (3): card(), control(), elements()

### Community 21 - "Snapshot"
Cohesion: 0.31
Nodes (4): subscribe(), Snapshot, fixture(), Response

### Community 23 - "Server TypeScript Build"
Cohesion: 0.22
Nodes (8): src/server, src/shared.ts, ./tsconfig.json, compilerOptions, outDir, rootDir, extends, include

### Community 24 - "theme.ts"
Cohesion: 0.43
Nodes (4): App(), applyTheme(), readTheme(), Theme

### Community 25 - "TaskMarkdown"
Cohesion: 0.40
Nodes (4): TaskMarkdown(), conversationPolling(), render(), taskCard()

### Community 26 - "reviewPlan.ts"
Cohesion: 0.80
Nodes (3): makeReviewPlan(), reviewImpact(), reviewsFor()

### Community 29 - "Agent Output Progress"
Cohesion: 0.14
Nodes (12): ModelPicker(), ReasoningPicker(), AgentOutput(), RunProgress(), allRoles, DependencyDiagnostic, legacyReviewRoles, ModelOption (+4 more)

## Knowledge Gaps
- **115 isolated node(s):** `name`, `version`, `private`, `type`, `node` (+110 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **4 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `createApp()` connect `Application and Spec Lifecycle` to `Review Planning and Shared Types`, `GitHub Issue Synchronization`, `Codex Execution and Failures`, `deletion.test.ts`, `Application Setup and Validation`, `Process Shutdown and Titles`, `Agent Output and Validation`, `Artifacts and Conversation Storage`, `Build Commits and Source Hashing`, `Snapshot`, `GitHub Smoke Checks`, `Agent Output Progress`?**
  _High betweenness centrality (0.077) - this node is a cross-community bridge._
- **Why does `Store` connect `Application and Spec Lifecycle` to `Review Planning and Shared Types`, `GitHub Issue Synchronization`, `Codex Execution and Failures`, `Dependency Validation and Schemas`, `deletion.test.ts`, `Git Operations and Publication`, `Application Setup and Validation`, `Process Shutdown and Titles`, `Agent Output and Validation`, `Artifacts and Conversation Storage`, `Snapshot`, `reviewPlan.ts`?**
  _High betweenness centrality (0.073) - this node is a cross-community bridge._
- **Why does `AgentRun` connect `Application and Spec Lifecycle` to `Review Planning and Shared Types`, `Codex Execution and Failures`, `Dependency Validation and Schemas`, `Client API and Task Controls`, `Scheduling and Process Logging`, `deletion.test.ts`, `Git Operations and Publication`, `Application Setup and Validation`, `Artifacts and Conversation Storage`, `reviewPlan.ts`, `Agent Output Progress`?**
  _High betweenness centrality (0.056) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `createApp()` (e.g. with `.run()` and `.events()`) actually correct?**
  _`createApp()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _115 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Application and Spec Lifecycle` be split into smaller, more focused modules?**
  _Cohesion score 0.07541059449456396 - nodes in this community are weakly interconnected._
- **Should `Documentation and Agent Workflows` be split into smaller, more focused modules?**
  _Cohesion score 0.07610993657505286 - nodes in this community are weakly interconnected._