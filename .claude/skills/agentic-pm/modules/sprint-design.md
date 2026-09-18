# Module: Sprint Design

## Overview
Sprint Design is the mandatory pre-execution workflow that transforms backlog items into a fully-planned, SR-approved sprint. No code is written during Sprint Design. All codebase interaction is read-only.

## When to Use
- **Mandatory** for sprints with 2+ tasks
- **Recommended** for single-task sprints (Steps 2-3 at minimum)
- **Required** before invoking any Agent Handoff workflow

## Workflow (8 Steps)

### Step 1: Define Sprint Goal + Select Candidates (PM)
- Query backlog for candidate items
- Draft sprint narrative (what and why)
- Check for existing `int/*` or `int-portal/*` branches
- **Output:** Candidate list + sprint goal

### Step 2: Current State Investigation (PM) — MANDATORY
- For each candidate: identify all files that will be touched
- For each candidate: trace the data flow end-to-end
- For each candidate: document platform-specific behavior
- For each candidate: identify integration points
- **This step is READ-ONLY. No code modifications.**
- **Output:** System state assessment per candidate

### Step 3: Draft Technical Requirements (PM)
- Define WHAT changes (not how) per candidate
- **Output:** Technical requirements per candidate

### Step 4: Draft Task Descriptions + Estimates (PM)
- Create detailed descriptions in Supabase pm_backlog_items.body
- Define file boundaries per task
- **Output:** Task descriptions with estimates

### Step 5: Dependency Analysis + Phase Plan (PM)
- Build file-overlap matrix
- Classify parallel vs sequential
- **Output:** Phase plan + dependency graph

### Step 6: SR Engineer Design Review (GATE)
- Validate completeness, accuracy, edge cases
- **Decision:** Approve / Request changes / Reject

### Step 7: Finalize Sprint (PM)
- Create sprint in Supabase (numbered: SPRINT-XXX)
- Create integration branch if needed
- Assign items to sprint

### Step 8: Handoff to Execution (PM)
- Sprint enters Agent Handoff workflow
- PM writes .current-task BEFORE EVERY agent invocation

## Anti-Patterns
- Writing tasks without Step 2 investigation
- Skipping SR review
- Modifying code during design phase
- Not updating .current-task before agents (breaks metrics)
