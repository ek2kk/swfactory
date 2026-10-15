# Graph Report - swfactory-pr-integration-20261015  (2026-10-15)

## Corpus Check
- 101 files · ~134,377 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 671 nodes · 2230 edges · 30 communities (25 shown, 5 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 44 edges (avg confidence: 0.76)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `8812e60d`
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
- Live Connection UI Tests
- Window and Modal Tests
- Chat Execution Lifecycle
- Server TypeScript Build
- Source
- Application Theme Settings
- smoke-github.ts
- Agent Output Progress

## God Nodes (most connected - your core abstractions)
1. `Store` - 94 edges
2. `createApp()` - 88 edges
3. `AgentRun` - 58 edges
4. `SpecController` - 47 edges
5. `saveArtifact()` - 19 edges
6. `GithubIssues` - 18 edges
7. `Problem` - 18 edges
8. `Project` - 18 edges
9. `Run` - 17 edges
10. `api()` - 16 edges

## Surprising Connections (you probably didn't know these)
- `Issue implementation workflow` --semantically_similar_to--> `Issue implementation workflow`  [INFERRED] [semantically similar]
  AGENTS.md → CLAUDE.md
- `render()` --indirect_call--> `TaskMarkdown()`  [INFERRED]
  test/taskMarkdown.test.ts → src/client/TaskMarkdown.tsx
- `taskCard()` --indirect_call--> `TaskMarkdown()`  [INFERRED]
  test/taskView.test.ts → src/client/TaskMarkdown.tsx
- `fixture()` --calls--> `createApp()`  [EXTRACTED]
  test/api.test.ts → src/server/app.ts
- `apiFixture()` --calls--> `createApp()`  [EXTRACTED]
  test/deletion.test.ts → src/server/app.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Requirements to reviewed GitHub publication** — readme_spec_modes, readme_review_plan, readme_github_publication, readme_source_integrity [EXTRACTED 1.00]
- **Independent visibility stop evidence and capacity** — docs_task_deletion_visibility, docs_task_deletion_stop_verification, readme_fifo_scheduler [EXTRACTED 1.00]

## Communities (30 total, 5 thin omitted)

### Community 0 - "Application and Spec Lifecycle"
Cohesion: 0.09
Nodes (19): createApp(), port, parseTask(), reviewMetadata(), Store, fixture(), fixture(), fixture() (+11 more)

### Community 1 - "Documentation and Agent Workflows"
Cohesion: 0.08
Nodes (44): URL ingestion and file watching, Graph exports and benchmark, Extraction evidence and JSON schema, GitHub cloning and cross-repo graphs, Post-commit graph rebuild hook, Vocabulary constrained graph traversal, Whisper transcription of media, Incremental extraction and graph merge (+36 more)

### Community 2 - "Runtime and Package Dependencies"
Cohesion: 0.05
Nodes (41): better-sqlite3, fastify, @fastify/static, dependencies, better-sqlite3, fastify, @fastify/static, react (+33 more)

### Community 3 - "Review Planning and Shared Types"
Cohesion: 0.15
Nodes (16): errorKind(), loggerOptions(), checkExecution(), context, ProcessLog, publishGithub(), Job, apiFixture() (+8 more)

### Community 4 - "GitHub Issue Synchronization"
Cohesion: 0.05
Nodes (52): applicableReview(), planResultsReset(), ResultsResetPlan, ResultsRestart, githubIssueCommand(), ImportFailure, ImportLoop, IssueCommand (+44 more)

### Community 5 - "Codex Execution and Failures"
Cohesion: 0.14
Nodes (25): directory, root, approveSchema, executeApprove, executeBuild, executeReview, executeSpec, list (+17 more)

### Community 6 - "Dependency Validation and Schemas"
Cohesion: 0.12
Nodes (20): buildSchema, reviewSchema, ConditionResult, dependenciesSchema, dependencyQuestion(), DiagnoseDependencies, githubLink(), text (+12 more)

### Community 7 - "Client API and Task Controls"
Cohesion: 0.17
Nodes (23): api(), ArchivedTask(), DependencyStatus(), History(), HumanDecision(), HumanQuestions(), IssueRefresh(), labels (+15 more)

### Community 9 - "Chat and Stage History"
Cohesion: 0.18
Nodes (10): eventTitles, HistoryItem, stageNames, stageRoles(), stageStatus(), stageTabStatus(), states, time() (+2 more)

### Community 10 - "Git Operations and Publication"
Cohesion: 0.05
Nodes (18): ModelPicker(), ReasoningPicker(), TaskMarkdown(), ModelOption, card(), control(), elements(), Source (+10 more)

### Community 11 - "Application Setup and Validation"
Cohesion: 0.10
Nodes (23): Action, description, equal(), object(), text, uuid, version, artifactDirectory() (+15 more)

### Community 12 - "Process Shutdown and Titles"
Cohesion: 0.21
Nodes (3): ProcessScope, resolveLog(), Titles

### Community 13 - "TypeScript and Vite Configuration"
Cohesion: 0.11
Nodes (17): DOM, ES2023, node, src, test, vite.config.ts, compilerOptions, esModuleInterop (+9 more)

### Community 14 - "Agent Output and Validation"
Cohesion: 0.19
Nodes (7): fetchBase(), preflight(), verifyRepository(), executionSignal(), SpecController, AgentRun, perform()

### Community 15 - "Artifacts and Conversation Storage"
Cohesion: 0.25
Nodes (13): saveArtifact(), CodexInput, executeResult(), classifyFailure(), FastModeFailure, prepareFast(), DeliveryError, executeInteractive() (+5 more)

### Community 16 - "Build Commits and Source Hashing"
Cohesion: 0.28
Nodes (11): base, root, blocked(), commitBuild(), fileContent(), paths(), safePath(), sourceHash() (+3 more)

### Community 17 - "SSE and Results Reset"
Cohesion: 0.24
Nodes (4): GithubIssues, Project, syncCard(), load()

### Community 18 - "Task View and Scroll State"
Cohesion: 0.18
Nodes (4): DescriptionDraft, HistoryFlow, Props, TaskView

### Community 19 - "Model Discovery and Catalogs"
Cohesion: 0.52
Nodes (4): readLog(), readTranscript(), transcriptEntry(), TranscriptEntry

### Community 20 - "Live Connection UI Tests"
Cohesion: 0.26
Nodes (7): repo, CodexFailure, Problem, generateTitle(), parseTitle(), titleToolRestrictions, FailureKind

### Community 23 - "Server TypeScript Build"
Cohesion: 0.22
Nodes (8): src/server, src/shared.ts, ./tsconfig.json, compilerOptions, outDir, rootDir, extends, include

### Community 24 - "Source"
Cohesion: 0.33
Nodes (6): Api, Composer(), delivery, Message(), RunConversation(), stageTimeline()

### Community 25 - "Application Theme Settings"
Cohesion: 0.43
Nodes (4): App(), applyTheme(), readTheme(), Theme

## Knowledge Gaps
- **116 isolated node(s):** `name`, `version`, `private`, `type`, `node` (+111 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `createApp()` connect `Application and Spec Lifecycle` to `Review Planning and Shared Types`, `GitHub Issue Synchronization`, `Codex Execution and Failures`, `Dependency Validation and Schemas`, `Application Setup and Validation`, `Agent Output and Validation`, `SSE and Results Reset`, `Model Discovery and Catalogs`, `Window and Modal Tests`, `smoke-github.ts`?**
  _High betweenness centrality (0.081) - this node is a cross-community bridge._
- **Why does `Store` connect `Application and Spec Lifecycle` to `Review Planning and Shared Types`, `GitHub Issue Synchronization`, `Codex Execution and Failures`, `Dependency Validation and Schemas`, `Application Setup and Validation`, `Process Shutdown and Titles`, `Agent Output and Validation`, `Artifacts and Conversation Storage`, `Build Commits and Source Hashing`, `SSE and Results Reset`, `Model Discovery and Catalogs`, `Live Connection UI Tests`, `Chat Execution Lifecycle`?**
  _High betweenness centrality (0.070) - this node is a cross-community bridge._
- **Why does `AgentRun` connect `Agent Output and Validation` to `Application and Spec Lifecycle`, `Review Planning and Shared Types`, `GitHub Issue Synchronization`, `Codex Execution and Failures`, `Dependency Validation and Schemas`, `Client API and Task Controls`, `Chat and Stage History`, `Application Setup and Validation`, `Artifacts and Conversation Storage`, `Build Commits and Source Hashing`, `Model Discovery and Catalogs`, `Chat Execution Lifecycle`, `Source`, `Agent Output Progress`?**
  _High betweenness centrality (0.060) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `createApp()` (e.g. with `.run()` and `.events()`) actually correct?**
  _`createApp()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _116 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Application and Spec Lifecycle` be split into smaller, more focused modules?**
  _Cohesion score 0.09275594760759155 - nodes in this community are weakly interconnected._
- **Should `Documentation and Agent Workflows` be split into smaller, more focused modules?**
  _Cohesion score 0.07610993657505286 - nodes in this community are weakly interconnected._