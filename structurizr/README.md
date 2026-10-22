## Structurizr diagrams (Sunnyview)

This repo includes a Structurizr DSL workspace at `structurizr/workspace.dsl`.

Status: the PNGs in `structurizr/diagrams/` predate the latest `workspace.dsl` update. The model now places MongoDB as the store for both history and projects, and the separate "Sunnyview Backend" system was removed from the model. Regenerate the PNGs with the steps below once the Structurizr CLI is available.

### Validate the DSL

Requires the Structurizr CLI installed at `structurizr/bin/structurizr-cli/` (not checked into the repo).

```bash
bash structurizr/bin/structurizr-cli/structurizr.sh validate -w structurizr/workspace.dsl
```

### Export an interactive static viewer

```bash
mkdir -p structurizr/out
bash structurizr/bin/structurizr-cli/structurizr.sh export -w structurizr/workspace.dsl -f static -o structurizr/out
```

Then open `structurizr/out/index.html` in a browser and use the diagram picker / arrow keys to switch views.

The view keys are `general-architecture` and `main-feature`. The export script depends on them.

### Export standalone PNG images (for README/GitHub)

1) Export the static viewer (step above).

2) Generate images:

```bash
npm run diagrams:export
```

Requirements:

- A static export at `structurizr/out` (step above).
- A Chrome, Chromium, or Microsoft Edge install. The script checks `CHROME_BIN` first, then the first match in common locations:
  - macOS: Google Chrome, Chromium, Microsoft Edge in `/Applications`
  - Windows: Google Chrome and Microsoft Edge under `Program Files` and `Program Files (x86)`
  - Linux: `/usr/bin/google-chrome`, `/usr/bin/google-chrome-stable`, `/usr/bin/chromium`, `/usr/bin/chromium-browser`

  Set the path explicitly if none of these match, for example `CHROME_BIN="/path/to/chrome" npm run diagrams:export`.

By default this generates 16:9 PNGs at `1920x1080`. Override the size with:

```bash
DIAGRAM_WIDTH=2560 DIAGRAM_HEIGHT=1440 npm run diagrams:export
```

`DIAGRAM_DPR` sets the device pixel ratio (default `1`).

Outputs:

- `structurizr/diagrams/general-architecture.png`
- `structurizr/diagrams/main-feature.png`
