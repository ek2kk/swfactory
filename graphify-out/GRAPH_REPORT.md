# Graph Report - /Users/ek/projects/swfactory  (2026-10-15)

## Corpus Check
- 99 files · ~127,670 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 646 nodes · 2131 edges · 33 communities (29 shown, 4 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 43 edges (avg confidence: 0.75)
- Token cost: AST 0; host-session semantic input/output usage unavailable (not measured).

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
- Application Theme Settings
- Markdown and Conversation Polling
- GitHub Smoke Checks
- Model and Reasoning Pickers
- Agent Output Progress
- SSE Source Test Double

## God Nodes (most connected - your core abstractions)
1. `Store` - 91 edges
2. `createApp()` - 85 edges
3. `AgentRun` - 55 edges
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
- `taskCard()` --indirect_call--> `TaskMarkdown()`  [INFERRED]
  test/taskView.test.ts → src/client/TaskMarkdown.tsx
- `app()` --indirect_call--> `TaskMarkdown()`  [INFERRED]
  test/windows.test.ts → src/client/TaskMarkdown.tsx
- `fixture()` --calls--> `createApp()`  [EXTRACTED]
  test/api.test.ts → src/server/app.ts
- `apiFixture()` --calls--> `createApp()`  [EXTRACTED]
  test/deletion.test.ts → src/server/app.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Requirements to reviewed GitHub publication** — readme_spec_modes, readme_review_plan, readme_github_publication, readme_source_integrity [EXTRACTED 1.00]
- **Independent visibility stop evidence and capacity** — docs_task_deletion_visibility, docs_task_deletion_stop_verification, readme_fifo_scheduler [EXTRACTED 1.00]

## Communities (33 total, 4 thin omitted)

### Community 0 - "Application and Spec Lifecycle"
Cohesion: 0.08
Nodes (27): createApp(), fetchBase(), preflight(), verifyRepository(), executionSignal(), SpecController, parseTask(), reviewMetadata() (+19 more)

### Community 1 - "Documentation and Agent Workflows"
Cohesion: 0.08
Nodes (44): URL ingestion and file watching, Graph exports and benchmark, Extraction evidence and JSON schema, GitHub cloning and cross-repo graphs, Post-commit graph rebuild hook, Vocabulary constrained graph traversal, Whisper transcription of media, Incremental extraction and graph merge (+36 more)

### Community 2 - "Runtime and Package Dependencies"
Cohesion: 0.05
Nodes (41): better-sqlite3, fastify, @fastify/static, dependencies, better-sqlite3, fastify, @fastify/static, react (+33 more)

### Community 3 - "Review Planning and Shared Types"
Cohesion: 0.12
Nodes (26): TaskCard(), stageRoles(), makeReviewPlan(), reviewImpact(), classifySpec(), schema, validateDecision(), ResultsCleanup (+18 more)

### Community 4 - "GitHub Issue Synchronization"
Cohesion: 0.13
Nodes (12): githubIssueCommand(), GithubIssues, ImportFailure, ImportLoop, IssueCommand, parseIssue(), GithubIssue, Project (+4 more)

### Community 5 - "Codex Execution and Failures"
Cohesion: 0.17
Nodes (20): directory, root, approveSchema, CodexInput, executeResult(), executeSpec, list, reviewSectionSchema (+12 more)

### Community 6 - "Dependency Validation and Schemas"
Cohesion: 0.11
Nodes (22): buildSchema, reviewSchema, ConditionResult, dependenciesSchema, dependencyQuestion(), DiagnoseDependencies, githubLink(), text (+14 more)

### Community 7 - "Client API and Task Controls"
Cohesion: 0.17
Nodes (21): api(), pendingRequests, ArchivedTask(), DependencyStatus(), History(), HumanDecision(), HumanQuestions(), IssueRefresh() (+13 more)

### Community 8 - "Scheduling and Process Logging"
Cohesion: 0.16
Nodes (10): errorKind(), loggerOptions(), context, ProcessLog, Job, Scheduler, titleToolRestrictions, apiFixture() (+2 more)

### Community 9 - "Chat and Stage History"
Cohesion: 0.13
Nodes (18): Api, Composer(), delivery, Message(), RunConversation(), eventTitles, HistoryItem, stageNames (+10 more)

### Community 10 - "Git Operations and Publication"
Cohesion: 0.17
Nodes (14): saveArtifact(), inspectProject(), remoteIdentity(), Run, checkExecution(), exec(), publishGithub(), Task (+6 more)

### Community 11 - "Application Setup and Validation"
Cohesion: 0.12
Nodes (14): Action, description, equal(), object(), text, uuid, version, readReport() (+6 more)

### Community 12 - "Process Shutdown and Titles"
Cohesion: 0.18
Nodes (3): ProcessScope, resolveLog(), Titles

### Community 13 - "TypeScript and Vite Configuration"
Cohesion: 0.11
Nodes (17): DOM, ES2023, node, src, test, vite.config.ts, compilerOptions, esModuleInterop (+9 more)

### Community 14 - "Agent Output and Validation"
Cohesion: 0.27
Nodes (14): repo, executeApprove, executeBuild, executeReview, nonempty(), validateApprove(), validateBuild(), validateReview() (+6 more)

### Community 15 - "Artifacts and Conversation Storage"
Cohesion: 0.22
Nodes (9): artifactDirectory(), readLog(), removeResultArtifacts(), DeliveryError, Problem, readTranscript(), transcriptEntry(), TranscriptEntry (+1 more)

### Community 16 - "Build Commits and Source Hashing"
Cohesion: 0.28
Nodes (11): base, root, blocked(), commitBuild(), fileContent(), paths(), safePath(), sourceHash() (+3 more)

### Community 17 - "SSE and Results Reset"
Cohesion: 0.16
Nodes (8): subscribe(), Snapshot, SpecResult, fixture(), needsInput, projectInput, fixture(), Response

### Community 18 - "Task View and Scroll State"
Cohesion: 0.18
Nodes (4): DescriptionDraft, HistoryFlow, Props, TaskView

### Community 19 - "Model Discovery and Catalogs"
Cohesion: 0.33
Nodes (6): discoverModels(), ModelCatalogs, normalizeModels(), defaultModels, ModelCatalog, models

### Community 20 - "Live Connection UI Tests"
Cohesion: 0.22
Nodes (3): card(), control(), elements()

### Community 21 - "Window and Modal Tests"
Cohesion: 0.27
Nodes (7): app(), button(), elements(), hooks(), load(), modal(), submit()

### Community 23 - "Server TypeScript Build"
Cohesion: 0.22
Nodes (8): src/server, src/shared.ts, ./tsconfig.json, compilerOptions, outDir, rootDir, extends, include

### Community 25 - "Application Theme Settings"
Cohesion: 0.43
Nodes (4): App(), applyTheme(), readTheme(), Theme

### Community 26 - "Markdown and Conversation Polling"
Cohesion: 0.40
Nodes (4): TaskMarkdown(), conversationPolling(), render(), taskCard()

### Community 28 - "Model and Reasoning Pickers"
Cohesion: 0.50
Nodes (3): ModelPicker(), ReasoningPicker(), ModelOption

## Knowledge Gaps
- **113 isolated node(s):** `name`, `version`, `private`, `type`, `node` (+108 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **4 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `createApp()` connect `Application and Spec Lifecycle` to `Review Planning and Shared Types`, `GitHub Issue Synchronization`, `Dependency Validation and Schemas`, `Scheduling and Process Logging`, `Git Operations and Publication`, `Application Setup and Validation`, `Artifacts and Conversation Storage`, `SSE and Results Reset`, `Model Discovery and Catalogs`, `GitHub Smoke Checks`?**
  _High betweenness centrality (0.081) - this node is a cross-community bridge._
- **Why does `Store` connect `Application and Spec Lifecycle` to `Review Planning and Shared Types`, `GitHub Issue Synchronization`, `Dependency Validation and Schemas`, `Scheduling and Process Logging`, `Git Operations and Publication`, `Application Setup and Validation`, `Process Shutdown and Titles`, `Agent Output and Validation`, `Artifacts and Conversation Storage`, `Build Commits and Source Hashing`, `SSE and Results Reset`, `Chat Execution Lifecycle`, `Agent Output Progress`?**
  _High betweenness centrality (0.070) - this node is a cross-community bridge._
- **Why does `AgentRun` connect `Application and Spec Lifecycle` to `Review Planning and Shared Types`, `Dependency Validation and Schemas`, `Client API and Task Controls`, `Scheduling and Process Logging`, `Chat and Stage History`, `Git Operations and Publication`, `Application Setup and Validation`, `Agent Output and Validation`, `Artifacts and Conversation Storage`, `Build Commits and Source Hashing`, `SSE and Results Reset`, `Chat Execution Lifecycle`, `Agent Output Progress`?**
  _High betweenness centrality (0.058) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `createApp()` (e.g. with `.run()` and `.events()`) actually correct?**
  _`createApp()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _113 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Application and Spec Lifecycle` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._
- **Should `Documentation and Agent Workflows` be split into smaller, more focused modules?**
  _Cohesion score 0.07610993657505286 - nodes in this community are weakly interconnected._
## Integrity and token accounting notes

Health warning: 289 dangling-endpoint edges; 43 undirected same-endpoint collapsed edges (39 under directed simulation). No missing endpoint fields or self-loops. Two JSON configuration files produced no AST nodes.

AST extraction uses no LLM tokens. Semantic extraction was performed by the host-session subagent; measured input/output token usage is unavailable from this platform. Zeros in the generated usage table and cost.json are unmeasured placeholders, not a zero-cost claim.
