### Fixed
- **An authoring command in the middle of a pipe no longer slips prose into scratch** (GH 2470): the no-prose-in-scratch gate checked only the first and last commands of a pipe, so `find . | echo plan | sort > $TMPDIR/x.txt` passed. It now checks every piped command; a bare `cat` past the head of the pipe relays its input and stays allowed.
