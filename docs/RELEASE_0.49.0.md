# Nexora POS v0.49.0

## Multi-branch inventory transfers

- First-class branch-to-branch inventory transfers.
- Atomic shipment: stock is reduced and transfer-out movement is recorded in one transaction.
- Atomic receipt: destination stock is increased and transfer-in movement plus immutable receipt are recorded in one transaction.
- Cross-branch sync is routed by source/destination branch identities.
- Server validates ownership: a source branch may publish the transfer, while only the destination branch may publish the receipt.
- Synced shipments cannot be cancelled; reverse transfers preserve audit history and avoid distributed cancellation races.
- Added branch directory and inventory transfer management UI.

## Release gates

Run `npm ci`, rebuild native modules, then test a real two-branch Windows deployment end-to-end before commercial release.
