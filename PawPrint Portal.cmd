@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul || (
  echo Node.js 22.12 or newer is required.
  pause
  exit /b 1
)

where gh >nul 2>nul || (
  echo GitHub CLI is required. Install it and run: gh auth login
  pause
  exit /b 1
)

where az >nul 2>nul || (
  echo Azure CLI is required. Install it and run: az login
  pause
  exit /b 1
)

gh auth status >nul 2>nul || (
  echo GitHub CLI is not signed in. Run: gh auth login
  pause
  exit /b 1
)

az account show >nul 2>nul || (
  echo Azure CLI is not signed in. Run: az login
  pause
  exit /b 1
)

call npm ci --ignore-scripts --prefer-offline || goto :failed

call npm run portal:build || goto :failed
call npm run portal
exit /b %errorlevel%

:failed
echo.
echo PawPrint Portal could not start. Review the error above.
pause
exit /b 1@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul || (
  echo Node.js 22.12 or newer is required.
  pause
  exit /b 1
)

where gh >nul 2>nul || (
  echo GitHub CLI is required. Install it and run: gh auth login
  pause
  exit /b 1
)

where az >nul 2>nul || (
  echo Azure CLI is required. Install it and run: az login
  pause
  exit /b 1
)

gh auth status >nul 2>nul || (
  echo GitHub CLI is not signed in. Run: gh auth login
  pause
  exit /b 1
)

az account show >nul 2>nul || (
  echo Azure CLI is not signed in. Run: az login
  pause
  exit /b 1
)

call npm ci --ignore-scripts --prefer-offline || goto :failed

call npm run portal:build || goto :failed
call npm run portal
exit /b %errorlevel%

:failed
echo.
echo PawPrint Portal could not start. Review the error above.
pause
exit /b 1@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul || (
  echo Node.js 22.12 or newer is required.
  pause
  exit /b 1
)

where gh >nul 2>nul || (
  echo GitHub CLI is required. Install it and run: gh auth login
  pause
  exit /b 1
)

where az >nul 2>nul || (
  echo Azure CLI is required. Install it and run: az login
  pause
  exit /b 1
)

gh auth status >nul 2>nul || (
  echo GitHub CLI is not signed in. Run: gh auth login
  pause
  exit /b 1
)

az account show >nul 2>nul || (
  echo Azure CLI is not signed in. Run: az login
  pause
  exit /b 1
)

call npm ci --ignore-scripts --prefer-offline || goto :failed

call npm run portal:build || goto :failed
call npm run portal
exit /b %errorlevel%

:failed
echo.
echo Pawprint Portal could not start. Review the error above.
pause
exit /b 1