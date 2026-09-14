# Semi-OS

Semi-OS is a local-first, voice-first desktop agent for controlling the computer,
delegating coding work, and safely completing browser and native desktop tasks.

The repository currently contains the product and technical design baseline.
Implementation will be added milestone by milestone after the architecture is
reviewed.

## Design

- [Detailed design](docs/DESIGN.md)
- [Decision log](docs/DECISIONS.md)
- [Architecture diagrams](docs/assets/architecture/)
- [Desktop assistant prototype](docs/assets/prototype/desktop-assistant.png)
- [Client prototype](docs/assets/prototype/client.png)
- [Feishu publishing source](docs/feishu/semi-os-design.xml)
- [Published Feishu design document](https://fcnvj81na5nb.feishu.cn/docx/TwtBdi7Iioeyq3xBXEpcXa6lnpd)

## MVP thesis

The first release validates one complete loop:

1. Hold a global shortcut and speak.
2. Receive an immediate voice acknowledgement.
3. Let the Pi-based runtime reason and choose tools.
4. Operate a browser, the macOS desktop, or a local coding agent.
5. Pause, steer, resume, or cancel a running task.
6. Ask for confirmation before external side effects.
7. Verify the real-world result and report it by voice.

## Status

Architecture and prototype phase. Product name and visual identity may still
evolve; `Semi-OS` is the repository and working product name.
