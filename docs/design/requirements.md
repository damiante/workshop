# Project overview

I have many projects which I'd like to develop using Claude Code but I'm not currently making efficient use of my weekly subscription limit as it requires me to be home at my desk and manually entering prompts and reviewing the output.
The goal of this project will be to make better use of my allowance by automating project development. We'll do this at a high level by periodically pulling tickets from my Git repos and then using a series of agents with jobs like:
1. Classifying ticket readiness, size, etc.
1. Making comments and applying tags to tickets for me to review
1. Developing the ticket using an appropriate dev agent
1. Adversarially assessing the implementation where appropriate and refining
1. Opening PRs with output of implementation
1. Merging approved PRs

With the goal of automating the process of me copy-pasting my Github ticket contents into Claude Code in my dev machine.


# Service architecture

The service should have at least two major components:
1. A web client for observing and managing the service
2. A web server which does the bulk of the work for the application

Users will interact with the web client to observe agents that the server is running as well as agent output/progress, logs, and manage connection to hosts. Design an appropriate web client using your UI design skill; the project's name is Workshop, I would like if it had a subtle and stylised wooden theme like the projects were taking place in a garden shed.

There are two diagrams (one SVG, the other a raw draw.io file) which you can read to get a high-level overview of what I'm trying to achieve from a technical perspective. Wherever a specific tool is mentioned throughout this document (eg "Github") assume that I want it implemented in a generic way via an interface through which that generic tool is one of many that may be configured (eg if I want to add support for a different git service tomorrow then it should be a matter of adding supported config for connecting to that service); having said that, the examples I give will be of the tools I actually use and so the first iteration of the project should target support for these.

At a high level:
- The user will enroll a project management tool (in my case Github Issues) from which project tickets can be pulled.
- The user will enroll a version control host (in my case Github.com) which will host source code for the project
- The user will enroll a hosting environment. This should be a docker environment on some machine.
- The user will enroll one or more AI models that the agents can use. In my case this will be Claude.

In all of the above cases, ensure that the tool has appropriate modals to prompt the user to correctly configure access (ie API keys etc.) and UI hints to show when one of these is successfully/unsuccessfully configured.

All of this config and other data should be stored in a database that the service has. Assume I would like this service to be deployed via Docker and ensure that the readme you write for the project contains an appropriate sample Docker Compose file (or create one somewhere else in the repo as appropriate).

# Agent configuration

Assuming at least one of each of the above services has been successfully configured, the user should be able to configure agent classes. The following agent classes should be available:

- Classifier
- Design
- Design-Adversary
- Implementation
- Merge

Each agent class should accept a model config, launch mode, and prompt. The intent is to allow a user to customise which model is assigned to each task; for example, I am likely to assign Claude Haiku 5.5 to "Classifier", Claude Opus 5.5 to Design and Design-Adversary, and Claude Sonnet 5.5 to Implementation and Merge. Ensure the available models come from the full set of enrolled AI models.

I also want to have each of these agent classes support a "launch mode" (you can choose a different name if you have a more appropriate one). Basically I intend to launch these using `claude -p` so they consume my subscription plan; however, I may in future want to use API-based billing for Claude (or some other provider), so I want the option to choose whether I'm launching the agent with subscription or API based billing.

Finally, each agent class should include an optional prompt which will describe what that agent is responsible for. Include a sensible default in each case that the user can subsequently edit. Remember that this needs to be added to the task content which the agent will get in later steps.

Agent roles:
- Classifier: Reads ticket description and comments, observes repo state, applies label for ticket t-shirt size (XS -> XL) based on complexity and label for lifecycle state. Creates git branch for work & assigns it to ticket. Optionally decides ticket is not appropriate for implementation (commentary, insufficient information, technically infeasible, etc.) and adds label to indicate no further processing.
- Design: Reads ticket description and comments, observes repo state, produces design for implementation based on ticket description. Optionally posts comment on ticket where further decisioning is needed. Design document included in branch. Updates labels after design written.
- Design-Adversary: Reads ticket description and comments, observes repo state, reviews design provided and adversarially criticises with suggested fixes for each criticism. Updates labels after design revised.
- Implement: Reads ticket description and comments, observes repo state, reviews design (if provided) and implements according to design and answered questions. Creates tests and runs test suites, revising on test failure. Raises PR to merge branch with main/master on success.
- Merge: Takes approved PR associated with ticket and attempts to merge to main/master, resolving merge conflicts. Closes ticket.


# Ticket lifecycle

I want to manage the lifecycle of my tickets using labels to manage their state. I have provided a simple state machine (svg + draw.io xml) to show how the tickets should state transition. I will reiterate it here:

1. Tickets without labels are assumed unproccessed. Such tickets need to be run through the Classifier which will assign it a size between XS and XL based on its perceived complexity. 
1. Once a ticket has been classified, if it is XS or S in size, it can go straight to being Implemented.
1. If the ticket is M, L, or XL in size, it needs to go through Design first. After this, if the ticket is M, it can be Implemented.
1. If the ticket is L or XL in size, it needs to go through Design-Adversary review after being Designed. After this, it can be Implemented.
1. A ticket that goes through Design, Design-Adversary, or Implemented can have a label added indicating that clarification is needed, and in this case the agent should add its question in the ticket comments, add the label, and stop. A ticket will then be reviewed by the user, have a comment added to answer, then the label removed. Expected behaviour is this ticket can then be picked up again for the same activity that it was doing before it was stopped due to the question.
1. A ticket being Implemented should always result in a PR being created. 
1. After the user reviews a PR, he can either Approve or Request Changes. If Approved, the ticket should be Merged by the Merge agent. If changes are requested, the process begins again with the Classifier identifying how big the requested change is relative to the content already on the branch.

All labels should be prefixed with `workshop/` so that they are known to be generated by the tool. These labels should be created automatically on enrollment of the repo/project management tool. As long as the above state transitions can be done I am not concerned with how else the labels are structured, just choose something logical.

# Agent management

As mentioned, I intend to launch agents using `claude -p` to consume my Claude Code token budget. I want a couple of checks made before an agent is launched:

1. Do not launch an agent if the weekly budget is >80% consumed or the 5-hourly budget is >70% consumed. Encode these values as config in the tool so I can tweak them.
1. Do not launch an agent if the host environment is full. The tool should have a configuration for the number/size of containers an environment can have. Default of one container per environment. Ideally, the host environment can be checked for resource availability prior to container launch but I'm not sure if this can be feasibly implemented given my design. Even more ideally, these config values for resource availability can be chosen by an agent (eg classifier) based on expected workload. I am also happy if the environment is checked on enrollment and categorised in terms of its available resources and this used as a heuristic to choose an execution env for a container; make an appropriate choice given implementation feasibility.
1. Do not attempt to launch an agent if the host environment is unavailable due to eg network.
1. Add config to the tool to specify available hours of operation (use host environment time); do not launch an agent if the current time is outside that range. Also have an override and instead ignore hours if the override is selected.
1. Do not attempt to launch an agent for a ticket if an agent is already running for the same ticket.

Once the tool determines that an agent can be launched, it should send a command to the docker environment for the host to start a container with the appropriate size and apply labels indicating what it's doing (ie which agent is running and what ticket). The tool needs a UI to monitor agents running through such containers; ideally a live feed of the agent output can be provided.

Agents launched in these containers must report back to Workshop after their tasks are completed so that the "not more than one agent per ticket at a time" constraint can be enforced. If a container dies due to being killed by the host or the host is lost due to eg networking, have an alert system in the tool that displays this.

Since agents are intended to be entirely remote, ensure that they are launched with appropriate permissions to automatically execute their tasks. If necessary, you may implement a callback handler that allows stopped instructions to be alerted and approved/denied from within the Workshop tool.

# Repo management
Once a repo management tool is connected, the list of repos for a user and his orgs should be fetched. The user should manually check which repos will participate in Workshop and only selected repos should have the above process applied to them.


# User access management

At this stage of the project I don't need to have more than one user of the tool at a time. However, I do plan to expose it to the internet so I can access it remotely. Implement a basic authentication process to protect the service from unauthorised access. In a previous project I encoded an environment variable into the docker compose file as a secret that a user must provide when trying to access the service; decide whether this is sufficient given the nature of the project and implement accordingly.


# Hygeine

After your implementation, document your design and service thoroughly. Write an AGENTS.md for the application, the client, and the server. Write a README.md for the project. Implement a GHA-based build system that builds the application into a Docker image on push to remote. Move this document and the other design docs into their own directory after completion.