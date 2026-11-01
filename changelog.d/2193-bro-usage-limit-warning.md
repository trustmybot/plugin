### Changed
- **Bro is told when a long session has become expensive** (GH 2193): once a session passes 150 tool calls or 60000 context per call, each bro turn carries a one-line warning naming the figures and the limits, and asks bro to finish what is in flight, end the session and resume cold from the DB. It is a nudge only: nothing is blocked, and sessions under both limits see no change.
