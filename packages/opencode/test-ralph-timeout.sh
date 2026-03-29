#!/bin/bash
# Test Ralph loop timeout fix
set -e

echo "Testing Ralph loop timeout fix..."

# Create a simple Ralph loop that should run without timing out
# This uses a basic oc check that should return exit 1 (clean) after the first iteration
timeout 30s bash -c '
  i=0
  while oc check "Output the exact text: RALPH_LOOP_TEST_COMPLETE"; do
    echo "Ralph loop iteration $((++i))"
    if [ $i -gt 3 ]; then
      echo "Breaking after 3 iterations to prevent infinite loop"
      break
    fi
  done
  echo "Ralph loop completed successfully!"
'

echo "Ralph loop test completed without timeout!"