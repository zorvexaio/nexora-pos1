# Nexora POS v0.52.13

## Features
- New: waiter ordering from phone/tablet browser. Any phone on the same store Wi-Fi can open https://<main-device-ip>:<port>/waiter, pair with the same 4-digit code used for terminal pairing, pick a table, browse the menu (with category tabs), and send an order. The order is added to that table (merged with anything already on it, never overwrites), the table becomes occupied, and a kitchen ticket prints automatically — exactly as if entered from the main cashier screen. Waiters cannot take payment or close the table from this device; that stays at the main cashier. The pairing screen (Settings > LAN sharing) now also shows the exact URL to open on the waiter's device.

## Fixes
- Scheduled order time ("تحديد وقت") was silently discarded for takeaway/pickup orders — it only worked for delivery orders, even though the cashier screen lets you pick a time for any order type. Now stored and shown (kitchen ticket + customer receipt) for any order type.
