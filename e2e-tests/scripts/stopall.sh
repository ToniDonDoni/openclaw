#!/bin/bash

DIR="$(cd "$(dirname "$0")" && pwd)"

"$DIR/stop.sh"
"$DIR/stop-tg-mock.sh"
