# How I used coding agents

I used coding agents iteratively for planning, implementation, and review—not as a one-shot code generator.

## 1. Discuss the product

I started a session with Claude Opus 5.5 to discuss what I wanted to build, the problem it should solve, and the experience I wanted users to have.

## 2. Define the requirements

Before implementation, I worked through the functional and non-functional requirements with the agent. This established the scope, expected behavior, reliability needs, and constraints.

## 3. Shape the architecture and targets

I described the architecture I wanted, including module boundaries and queue-based background processing. We also defined target metrics and used back-of-the-envelope calculations to reason about expected capacity and performance. These were planning targets, not measured guarantees.

## 4. Choose tools for each part

Once the requirements and architecture were clear, I selected tools for the different parts of the system. The design guided those choices, rather than starting with a stack and shaping the product around it.

## 5. Refine the plan and delegate implementation

I went back and forth with the planning agent until the implementation plan was settled. I then delegated implementation to a sub-agent using GPT 6 Sol to produce the first working codebase.

## 6. Improve the codebase iteratively

The first implementation was a starting point. I continued working with agents to improve the scaffolding, module structure, and code quality. I also refined tooling choices to make the codebase cleaner, easier to maintain, and better prepared for future scaling.

## 7. Review and verify

I used agents to review the implementation, identify defects, and verify fixes through formatting, typechecking, automated tests, and a real Docker demo. Later iterations focused on necessary fixes, clearer documentation, and removing unnecessary complexity.

I drove the requirements, architectural direction, and trade-offs; the agents helped refine the plan, implement it, and review the results.
