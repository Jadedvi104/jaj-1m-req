# Graph Report - .  (2026-09-17)

## Corpus Check
- Corpus is ~31,430 words - fits in a single context window. You may not need a graph.

## Summary
- 588 nodes · 948 edges · 28 communities (22 shown, 6 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 12 edges (avg confidence: 0.88)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Validation and Guards|Validation and Guards]]
- [[_COMMUNITY_In-Memory Repositories|In-Memory Repositories]]
- [[_COMMUNITY_Application and Database|Application and Database]]
- [[_COMMUNITY_Order Validation|Order Validation]]
- [[_COMMUNITY_Azure CICD|Azure CI/CD]]
- [[_COMMUNITY_Core Application|Core Application]]
- [[_COMMUNITY_Payments|Payments]]
- [[_COMMUNITY_Azure Event Hubs|Azure Event Hubs]]
- [[_COMMUNITY_Azure PostgreSQL|Azure PostgreSQL]]
- [[_COMMUNITY_Development Tooling|Development Tooling]]
- [[_COMMUNITY_Table Sessions|Table Sessions]]
- [[_COMMUNITY_TypeScript Configuration|TypeScript Configuration]]
- [[_COMMUNITY_NPM Scripts|NPM Scripts]]
- [[_COMMUNITY_Redis Integration|Redis Integration]]
- [[_COMMUNITY_Runtime Dependencies|Runtime Dependencies]]
- [[_COMMUNITY_Load Smoke Testing|Load Smoke Testing]]
- [[_COMMUNITY_Target Architecture|Target Architecture]]
- [[_COMMUNITY_Package Metadata|Package Metadata]]
- [[_COMMUNITY_Jest Configuration|Jest Configuration]]
- [[_COMMUNITY_Nest Build Configuration|Nest Build Configuration]]
- [[_COMMUNITY_Local Container Stack|Local Container Stack]]
- [[_COMMUNITY_Container Smoke Script|Container Smoke Script]]
- [[_COMMUNITY_Build Exclusions|Build Exclusions]]
- [[_COMMUNITY_Architecture Reviews|Architecture Reviews]]
- [[_COMMUNITY_Azure Deployment Script|Azure Deployment Script]]
- [[_COMMUNITY_GitHub Setup Script|GitHub Setup Script]]
- [[_COMMUNITY_Health Endpoints|Health Endpoints]]

## God Nodes (most connected - your core abstractions)
1. `DatabaseService` - 28 edges
2. `scripts` - 21 edges
3. `compilerOptions` - 21 edges
4. `Product` - 18 edges
5. `User` - 18 edges
6. `CreateOrderDto` - 17 edges
7. `CreateProductDto` - 15 edges
8. `UpdateProductDto` - 15 edges
9. `OrdersService` - 14 edges
10. `UpdateUserDto` - 14 edges

## Surprising Connections (you probably didn't know these)
- `Measure Scalability Before Architectural Change` --semantically_similar_to--> `Capacity Proof`  [INFERRED] [semantically similar]
  CODE_REFACTORING_REVIEW.md → ARCHITECTURE.md
- `Production Acceptance Gates` --semantically_similar_to--> `Capacity Proof`  [INFERRED] [semantically similar]
  TESTING.md → ARCHITECTURE.md
- `Staff Authorization Boundary` --semantically_similar_to--> `Tenant Isolation Release Gate`  [INFERRED] [semantically similar]
  FRONTEND_NEXTJS_GUIDE.md → SECURITY_AUDIT.md
- `Test and Build Job` --conceptually_related_to--> `PostgreSQL Integration Suite`  [INFERRED]
  .github/workflows/test.yml → TESTING.md
- `Azure Event Hubs for Kafka` --conceptually_related_to--> `Idempotent Kafka Consumers`  [INFERRED]
  infra/README.md → ARCHITECTURE.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Target Synchronous Request Path** — architecture_stateless_api_replicas, architecture_distributed_cache, architecture_postgresql_source_of_truth [EXTRACTED 1.00]
- **CI-Verified Image Deployment Flow** — _github_workflows_test_test_and_build_job, _github_workflows_test_verified_deployment_image, _github_workflows_test_testing_deployment, _github_workflows_test_production_deployment [EXTRACTED 1.00]
- **Local Restaurant Application Stack** — compose_api_service, compose_postgresql_service, compose_redpanda_service, compose_kafka_topic_initializer [EXTRACTED 1.00]

## Communities (28 total, 6 thin omitted)

### Community 0 - "Validation and Guards"
Cohesion: 0.07
Nodes (33): DemoOnlyGuard, Injectable, order, pipe, CreateProductDto, IsNotEmpty, IsNumber, IsString (+25 more)

### Community 1 - "In-Memory Repositories"
Cohesion: 0.08
Nodes (29): Identifiable, InMemoryRepository, Repository, CreateUserDto, IsEmail, IsNotEmpty, IsString, MaxLength (+21 more)

### Community 2 - "Application and Database"
Cohesion: 0.06
Nodes (24): AppModule, Module, configureApp(), createHttpAdapter(), DatabaseService, Injectable, HealthController, Controller (+16 more)

### Community 3 - "Order Validation"
Cohesion: 0.06
Nodes (39): ArrayMaxSize, ArrayMinSize, IsArray, CreateOrderDto, CreateOrderItemDto, IsInt, IsNotEmpty, IsString (+31 more)

### Community 4 - "Azure CI/CD"
Cohesion: 0.05
Nodes (46): GitHub CI Setup Script, Pipeline Activation, Azure Deployment Workflow, Branch Deployment Guard, Deploy Azure Script, OIDC Azure Login, Container Smoke Test, Production Deployment Job (+38 more)

### Community 5 - "Core Application"
Cohesion: 0.09
Nodes (22): AppController, Controller, Get, AppService, Injectable, DatabaseModule, Global, Module (+14 more)

### Community 6 - "Payments"
Cohesion: 0.11
Nodes (19): Transaction, ConfirmPaymentDto, IsInt, IsNotEmpty, IsString, Matches, Max, MaxLength (+11 more)

### Community 7 - "Azure Event Hubs"
Cohesion: 0.09
Nodes (24): type, value, contentVersion, metadata, type, defaultValue, type, metadata (+16 more)

### Community 8 - "Azure PostgreSQL"
Cohesion: 0.09
Nodes (24): defaultValue, type, metadata, type, contentVersion, type, value, defaultValue (+16 more)

### Community 9 - "Development Tooling"
Cohesion: 0.08
Nodes (25): devDependencies, eslint, eslint-config-prettier, @eslint/eslintrc, @eslint/js, eslint-plugin-prettier, globals, jest (+17 more)

### Community 10 - "Table Sessions"
Cohesion: 0.13
Nodes (14): CreateTableSessionDto, IsNotEmpty, IsString, IsUUID, Matches, MaxLength, TableSessionsController, Body (+6 more)

### Community 11 - "TypeScript Configuration"
Cohesion: 0.09
Nodes (21): compilerOptions, allowSyntheticDefaultImports, baseUrl, declaration, emitDecoratorMetadata, esModuleInterop, experimentalDecorators, forceConsistentCasingInFileNames (+13 more)

### Community 12 - "NPM Scripts"
Cohesion: 0.10
Nodes (21): scripts, build, check, db:migrate, format, lint, lint:check, start (+13 more)

### Community 13 - "Redis Integration"
Cohesion: 0.16
Nodes (8): Inject, REDIS_CLIENT, RedisModule, Global, Module, RedisClient, RedisService, Injectable

### Community 14 - "Runtime Dependencies"
Cohesion: 0.15
Nodes (13): dependencies, class-transformer, class-validator, kafkajs, @nestjs/common, @nestjs/config, @nestjs/core, @nestjs/platform-express (+5 more)

### Community 15 - "Load Smoke Testing"
Cohesion: 0.15
Nodes (11): concurrency, durationSeconds, maxErrorRate, maxP95, origin, p95, paths, samples (+3 more)

### Community 16 - "Target Architecture"
Cohesion: 0.20
Nodes (10): Distributed Cache, Idempotent Kafka Consumers, PostgreSQL Durable Source of Truth, Stateless NestJS Fastify Replicas, Transactional Outbox, Outbox Claim Leases, Canonical Idempotency Request Fingerprint, Idempotent Checkout Recovery Flow (+2 more)

### Community 17 - "Package Metadata"
Cohesion: 0.20
Nodes (9): author, description, license, name, overrides, fastify, qs, private (+1 more)

### Community 18 - "Jest Configuration"
Cohesion: 0.22
Nodes (9): jest, collectCoverageFrom, coverageDirectory, moduleFileExtensions, rootDir, testEnvironment, testRegex, transform (+1 more)

### Community 19 - "Nest Build Configuration"
Cohesion: 0.33
Nodes (5): collection, compilerOptions, deleteOutDir, $schema, sourceRoot

### Community 20 - "Local Container Stack"
Cohesion: 0.70
Nodes (5): Restaurant API Container, orders.v1 Topic Initializer, Local Container Stack, PostgreSQL 17 Service, Redpanda Kafka-Compatible Service

## Knowledge Gaps
- **177 isolated node(s):** `$schema`, `contentVersion`, `defaultValue`, `type`, `defaultValue` (+172 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `CreateOrderDto` connect `Order Validation` to `Validation and Guards`?**
  _High betweenness centrality (0.037) - this node is a cross-community bridge._
- **Why does `DatabaseService` connect `Application and Database` to `Table Sessions`, `Order Validation`, `Core Application`, `Payments`?**
  _High betweenness centrality (0.034) - this node is a cross-community bridge._
- **Why does `ConfirmPaymentDto` connect `Payments` to `Validation and Guards`?**
  _High betweenness centrality (0.025) - this node is a cross-community bridge._
- **What connects `$schema`, `contentVersion`, `defaultValue` to the rest of the system?**
  _184 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Validation and Guards` be split into smaller, more focused modules?**
  _Cohesion score 0.07322068612391193 - nodes in this community are weakly interconnected._
- **Should `In-Memory Repositories` be split into smaller, more focused modules?**
  _Cohesion score 0.07720782654680064 - nodes in this community are weakly interconnected._
- **Should `Application and Database` be split into smaller, more focused modules?**
  _Cohesion score 0.05669199298655757 - nodes in this community are weakly interconnected._