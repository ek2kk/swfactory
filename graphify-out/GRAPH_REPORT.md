# Graph Report - 3d22fe0b-7163-4078-86e4-369f5bd3eaa6  (2026-10-15)

## Corpus Check
- 100 files · ~130,515 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 662 nodes · 2183 edges · 21 communities (19 shown, 2 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 42 edges (avg confidence: 0.75)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `f41ce2a4`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Application and Spec Lifecycle
- Documentation and Agent Workflows
- Runtime and Package Dependencies
- Review Planning and Shared Types
- GitHub Issue Synchronization
- Codex Execution and Failures
- Client API and Task Controls
- Scheduling and Process Logging
- Chat and Stage History
- AgentRun
- TypeScript and Vite Configuration
- app.ts
- SSE and Results Reset
- Task View and Scroll State
- Model Discovery and Catalogs
- Window and Modal Tests
- Server TypeScript Build
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
  test/api.test.ts → src/server/app.ts
- `apiFixture()` --calls--> `createApp()`  [EXTRACTED]
  test/deletion.test.ts → src/server/app.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Requirements to reviewed GitHub publication** — readme_spec_modes, readme_review_plan, readme_github_publication, readme_source_integrity [EXTRACTED 1.00]
- **Independent visibility stop evidence and capacity** — docs_task_deletion_visibility, docs_task_deletion_stop_verification, readme_fifo_scheduler [EXTRACTED 1.00]

## Communities (21 total, 2 thin omitted)

### Community 0 - "Application and Spec Lifecycle"
Cohesion: 0.08
Nodes (26): createApp(), removeResultArtifacts(), subscribe(), parseTask(), reviewMetadata(), Store, Settings, fixture() (+18 more)

### Community 1 - "Documentation and Agent Workflows"
Cohesion: 0.08
Nodes (44): URL ingestion and file watching, Graph exports and benchmark, Extraction evidence and JSON schema, GitHub cloning and cross-repo graphs, Post-commit graph rebuild hook, Vocabulary constrained graph traversal, Whisper transcription of media, Incremental extraction and graph merge (+36 more)

### Community 2 - "Runtime and Package Dependencies"
Cohesion: 0.05
Nodes (41): better-sqlite3, fastify, @fastify/static, dependencies, better-sqlite3, fastify, @fastify/static, react (+33 more)

### Community 3 - "Review Planning and Shared Types"
Cohesion: 0.06
Nodes (64): repo, blocked(), commitBuild(), fileContent(), paths(), safePath(), sourceHash(), ConditionResult (+56 more)

### Community 4 - "GitHub Issue Synchronization"
Cohesion: 0.12
Nodes (13): githubIssueCommand(), GithubIssues, ImportFailure, ImportLoop, IssueCommand, parseIssue(), GithubIssue, Project (+5 more)

### Community 5 - "Codex Execution and Failures"
Cohesion: 0.25
Nodes (8): Api, Composer(), delivery, Message(), RunConversation(), stageTimeline(), time(), HumanRequest

### Community 7 - "Client API and Task Controls"
Cohesion: 0.15
Nodes (22): api(), pendingRequests, ArchivedTask(), DependencyStatus(), History(), HumanDecision(), HumanQuestions(), IssueRefresh() (+14 more)

### Community 8 - "Scheduling and Process Logging"
Cohesion: 0.09
Nodes (13): errorKind(), loggerOptions(), checkExecution(), context, ProcessLog, ProcessScope, resolveLog(), Job (+5 more)

### Community 9 - "Chat and Stage History"
Cohesion: 0.17
Nodes (11): TaskCard(), eventTitles, HistoryItem, stageNames, stageRoles(), stageStatus(), stageTabStatus(), states (+3 more)

### Community 10 - "AgentRun"
Cohesion: 0.25
Nodes (7): fetchBase(), preflight(), verifyRepository(), executionSignal(), SpecController, AgentRun, perform()

### Community 13 - "TypeScript and Vite Configuration"
Cohesion: 0.11
Nodes (17): DOM, ES2023, node, src, test, vite.config.ts, compilerOptions, esModuleInterop (+9 more)

### Community 14 - "app.ts"
Cohesion: 0.09
Nodes (20): headers, Action, description, equal(), object(), text, uuid, version (+12 more)

### Community 18 - "Task View and Scroll State"
Cohesion: 0.18
Nodes (4): DescriptionDraft, HistoryFlow, Props, TaskView

### Community 19 - "Model Discovery and Catalogs"
Cohesion: 0.06
Nodes (57): base, root, directory, root, saveArtifact(), approveSchema, buildSchema, CodexInput (+49 more)

### Community 21 - "Window and Modal Tests"
Cohesion: 0.05
Nodes (18): ModelPicker(), ReasoningPicker(), TaskMarkdown(), ModelOption, card(), control(), elements(), Source (+10 more)

### Community 23 - "Server TypeScript Build"
Cohesion: 0.22
Nodes (8): src/server, src/shared.ts, ./tsconfig.json, compilerOptions, outDir, rootDir, extends, include

### Community 25 - "Application Theme Settings"
Cohesion: 0.43
Nodes (4): App(), applyTheme(), readTheme(), Theme

## Knowledge Gaps
- **115 isolated node(s):** `name`, `version`, `private`, `type`, `node` (+110 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `createApp()` connect `Application and Spec Lifecycle` to `Review Planning and Shared Types`, `GitHub Issue Synchronization`, `Scheduling and Process Logging`, `AgentRun`, `app.ts`, `Model Discovery and Catalogs`?**
  _High betweenness centrality (0.081) - this node is a cross-community bridge._
- **Why does `Store` connect `Application and Spec Lifecycle` to `Review Planning and Shared Types`, `GitHub Issue Synchronization`, `Scheduling and Process Logging`, `AgentRun`, `app.ts`, `SSE and Results Reset`, `Model Discovery and Catalogs`?**
  _High betweenness centrality (0.070) - this node is a cross-community bridge._
- **Why does `AgentRun` connect `AgentRun` to `Application and Spec Lifecycle`, `Review Planning and Shared Types`, `Codex Execution and Failures`, `Client API and Task Controls`, `Scheduling and Process Logging`, `Chat and Stage History`, `app.ts`, `SSE and Results Reset`, `Model Discovery and Catalogs`, `Agent Output Progress`?**
  _High betweenness centrality (0.057) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `createApp()` (e.g. with `.run()` and `.events()`) actually correct?**
  _`createApp()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _115 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Application and Spec Lifecycle` be split into smaller, more focused modules?**
  _Cohesion score 0.07502799552071669 - nodes in this community are weakly interconnected._
- **Should `Documentation and Agent Workflows` be split into smaller, more focused modules?**
  _Cohesion score 0.07610993657505286 - nodes in this community are weakly interconnected._