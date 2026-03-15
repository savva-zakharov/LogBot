# LogBot

A Discord bot for War Thunder that monitors player logs and calculates squadron points.

## Features

- Monitors player logs and generates per battle log summaries
- Monitors the squadron points for the whole squadron
- Tracks low-point players and issues warnings
- Manages meta vehicle lists
- Tracks incident-free days
- Displays squadron leaderboards and rankings

## Setup

- On first run, the app will take you through a setup wizard that will ask for your Discord bot details, War Thunder squadron details and player details.
- The setup can be rerun at any time using the `--setup` argument.

## Command Line Arguments

| Argument | Description |
|----------|-------------|
| `--setup` | Runs the setup wizard |
| `--nowebserver` | Disables the web server |
| `--nodiscordbot` | Disables the Discord bot |
| `--nowtscrape` | Disables the War Thunder scraper |
| `--nowebscrape` | Disables the squadron points scraper |
| `--server` | Equivalent to passing both `--nowtscrape` and `--nowebscrape` |
| `--client` | Equivalent to passing both `--nodiscordbot` and `--nowebscrape` |

## Discord Bot Commands

### Administration Commands

| Command | Description | Permissions |
|---------|-------------|-------------|
| `/updatebot` | Runs the update scripts to fetch git refs and update npm packages | Admins/Owner |
| `/version` | Replies with the app version & latest commit hash | Everyone |
| `/restart` | Restarts the bot | Admins/Owner |
| `/settings` | View and edit core bot settings (channels, URLs, roles) | Admins/Owner |

### Squadron & Player Stats Commands

| Command | Description |
|---------|-------------|
| `/session` | Show the current squadron session summary with points, place, and W/L ratio |
| `/rank` | Show the squadron current rank on the leaderboard |
| `/leaderboard` | Display the full squadron leaderboard |
| `/top20` | Show the top 20 players in the squadron |
| `/top128` | Show the top 128 players in the squadron |
| `/bottom20` | Show the bottom 20 players in the squadron |
| `/points` | Show detailed points breakdown for a specific player |
| `/lowpoint` | Manage low-points role issuing (set threshold, view/list/ignore players) |
| `/waiting` | Show players waiting for a session in the waiting room channel |

### Meta & Reference Commands

| Command | Description |
|---------|-------------|
| `/meta` | Show the current meta vehicles for a specific battle rating |
| `/metalist` | Link to the Metalist spreadsheet |
| `/metamanage` | Upload a new Metalist CSV file |
| `/bombs` | Link to the bombs spreadsheet |
| `/missiles` | Link to the missiles spreadsheet |
| `/radars` | Link to the radars spreadsheet |
| `/sqbbr` | Reply with the preset SQBBR message from settings.json |

### Utility Commands

| Command | Description |
|---------|-------------|
| `/incident` | Show days since the last incident was reported |
| `/marco` | Responds with Polo! (test command) |
