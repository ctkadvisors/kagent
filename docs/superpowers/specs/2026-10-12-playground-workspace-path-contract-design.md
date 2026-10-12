# Playground workspace commit path contract

Approved scope: clarify the existing `fleet.playground_commit_files` contract.
The descriptor incorrectly says destinations are repository-relative, whereas
`playground-push.py` writes each supplied key beneath the selected folder.

Keep the API and path handling unchanged. Describe map keys as relative to
`folder`, map values as relative to the task workspace, and the resulting
repository path as `folder/destination`. Publish a complete executable schema
example with a folder-prefixed workspace source and an unprefixed destination.
Do not strip prefixes or reject legitimate same-name subdirectories.

Execute the advertised example through gateway describe/invoke with real saved
UTF-8 files, checking selected read paths, exact signed POST bytes and digests.
Exercise the same example against the actual Python playground service and a
local bare Git repository; reread the committed root and exclude an accidental
nested destination. Grants, HMAC, validation and original commit API stay intact.
