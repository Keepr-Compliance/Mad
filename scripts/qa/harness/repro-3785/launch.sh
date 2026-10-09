#!/bin/bash
# BACKLOG-3785 repro launcher: dev fixture mode, real HOME, mock keychain, watchdog.
S=${SCRATCH:?set SCRATCH}
cd /Users/daniel/Developer/Mad-3785r
: > $S/electron.log
log stream --style compact --predicate 'process == "Electron" AND (subsystem == "com.apple.securityd" OR subsystem == "com.apple.security" OR eventMessage CONTAINS[c] "keychain")' > $S/seclog.txt 2>&1 &
LOGPID=$!
KEEPR_DEV_FIXTURE_REPLAY_SLIM=${SLIM:-0} KEEPR_DEV_FIXTURE_REPLAY=${REPLAY:-0} KEEPR_DEV_FIXTURE_MODE=1 KEEPR_DEV_FIXTURE_KEY=$(cat $S/fixturekey.txt) KEEPR_USER_DATA_DIR=$S/keepr-3785 KEEPR_IPC_PROBE=1 \
  node_modules/.bin/electron . --use-mock-keychain --remote-debugging-port=9337 --remote-allow-origins='*' >> $S/electron.log 2>&1 &
APP=$!
echo "APP=$APP" > $S/app.pid
# watchdog: any real local-source read or keychain use -> kill immediately
while kill -0 $APP 2>/dev/null; do
  if grep -qE "Opening macOS Messages database|Starting macOS Messages import|\]   read: |Library/Messages/chat.db\"|AddressBook-v22" $S/electron.log; then
    echo "WATCHDOG: local source read detected, killing" >> $S/electron.log; kill -TERM $APP; sleep 2; kill -KILL $APP 2>/dev/null
  fi
  if grep -v "^Filtering the log data" $S/seclog.txt | grep -v "SecKeychainAddCallback" | grep -v "MacOS error: -67062" | grep -qiE "SecItem|SecKeychain|keychain|securityd"; then
    echo "WATCHDOG: keychain activity detected, killing" >> $S/electron.log; kill -TERM $APP; sleep 2; kill -KILL $APP 2>/dev/null
  fi
  sleep 0.5
done
kill $LOGPID 2>/dev/null
