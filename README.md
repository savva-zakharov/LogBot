# LogBot

A Discord bot for War Thunder that monitors player logs and calculates squadron points.

## Features

- Monitors player logs and generates per battle log summaries
- Monitors the squadron points for the whole squadron

## Setup

- On first run, the app will take you through a setup wizard that will ask for your Discord bot details, War Thunder squadron details and player details.
the setup can be rerun at any time using the --setup argument.

## Command Line Arguments

- --setup runs the setup wizard
- --nowebserver disables the web server
- --nodiscordbot disables the discord bot
- --nowtscrape disables the war thunder scraper
- --nowebscrape disables the squardon points scraper
- --server equivalent to passing both --nowtscrape and --nowebserver
- --client equivalent to passing both --nodiscordbot and --nowebscrape

##Discord Bot Commands
- /updatebot - runs the update scripts to fetch git refs and update npm packages (admins or owner only)
- /version - replies with the app version & latest commit hash.
- /restart - restarts the bot (admins or owner only) 
