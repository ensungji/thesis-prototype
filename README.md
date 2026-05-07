# Braille Trainer Prototype

A React Native mobile app paired with an ESP32-based braille display device for learning and practicing braille. Thesis prototype.

## Project Structure

```
thesis-prototype/
├── mobile/      # React Native (Expo) mobile application
└── firmware/    # ESP32 firmware (PlatformIO)
```

## Tech Stack

**Mobile**
- React Native + Expo SDK 54
- Expo Dev Client (custom native runtime)
- NativeWind v4 (Tailwind CSS for React Native)
- TypeScript
- Target: Android (iOS deferred)

**Backend**
- Supabase (PostgreSQL, Auth)

**Speech-to-Text**
- Cloud STT API (provider TBD: Whisper / Google / Deepgram)

**Firmware**
- ESP32 microcontroller
- PlatformIO + Arduino framework
- C++

**Hardware**
- 6× solenoids (single braille cell)
- I2S microphone
- I2S speaker
- Tactile buttons (Next, Back, Long-press)

**Communication**
- WiFi + WebSocket (JSON messages)

**Build & Deploy**
- EAS Build (Expo cloud builds → Android APK)

---

## Getting Started (New Contributors)

### Prerequisites
- Node.js 20.19.4+ ([download](https://nodejs.org))
- Git ([download](https://git-scm.com))
- VSCode ([download](https://code.visualstudio.com))
- VSCode extensions: PlatformIO IDE, ES7+ React/Redux/React-Native snippets, Tailwind CSS IntelliSense, Prettier, ESLint

### First-time setup

```bash
# 1. Clone the repo
git clone https://github.com/ensungji/thesis-prototype.git
cd thesis-prototype

# 2. Install mobile dependencies
cd mobile
npm install

# 3. (firmware setup will be added later)
```

---

## Team Workflow

We use a **feature branch + pull request** workflow. Nobody pushes directly to `main`. Every change goes through a pull request that another team member reviews.

### Branch naming

| Prefix      | When to use                          | Example                          |
|-------------|--------------------------------------|----------------------------------|
| `feature/`  | New functionality                    | `feature/websocket-client`       |
| `fix/`      | Bug fixes                            | `fix/braille-pattern-h`          |
| `docs/`     | Documentation only                   | `docs/setup-instructions`        |
| `chore/`    | Housekeeping (deps, configs, etc.)   | `chore/update-expo-sdk`          |

Use lowercase, hyphens for spaces, descriptive but short.

### Daily workflow

```bash
# 1. Always start from the latest main
git checkout main
git pull

# 2. Create a feature branch
git checkout -b feature/short-description

# 3. Do your work. Commit often with clear messages.
git add .
git commit -m "Add WebSocket connection helper"

# (repeat work + commits as needed)

# 4. Push the branch
git push -u origin feature/short-description
```

### Opening a Pull Request

1. After pushing, go to the repo on GitHub.
2. You'll see a yellow banner: **"feature/short-description had recent pushes — Compare & pull request"**. Click it.
3. Write a clear title and description:
   - **What** changed
   - **Why** it changed
   - **How to test** it (if relevant)
4. On the right side, request a review from a teammate.
5. Click **Create pull request**.

### Reviewing a Pull Request (for the reviewer)

1. Open the PR. Click the **Files changed** tab to see the diff.
2. Read through the changes. Click any line to leave a comment.
3. Click **Review changes** (top-right of Files changed):
   - **Comment** — questions or notes, no decision yet.
   - **Approve** — looks good, ready to merge.
   - **Request changes** — must be fixed before merge.
4. If approved, the PR author (or reviewer) clicks **Merge pull request** → **Confirm merge**.
5. Click **Delete branch** after merging to keep the branch list clean.

### After your PR is merged

```bash
# Switch back to main and pull the merged changes
git checkout main
git pull

# Delete your local feature branch (it's now in main)
git branch -d feature/short-description
```

---

## Rules

- **Never push directly to `main`.** Always work on a feature branch.
- **Never commit secrets** (API keys, passwords, `.env` files). Run `git status` and `git diff --staged` before every commit.
- **Pull `main` before starting new work** to avoid conflicts.
- **Write clear commit messages.** Future you will thank present you.
- **Keep PRs small.** A PR that touches 5 files is easier to review than one that touches 50.

---

## Status

🚧 Under active development — thesis prototype.