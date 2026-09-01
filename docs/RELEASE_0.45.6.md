# Nexora POS v0.45.6 — Professional Staff Payroll & Printer Routing

- Rebuilt payroll around real staff records: name, job, pay type, and pay rate.
- Payroll-only workers such as cooks, cleaners, waiters, drivers, and warehouse staff do not receive a login account and do not appear in user management.
- Supports monthly, daily, and hourly pay with regular-hours entry for hourly workers.
- Monthly payroll remains an internal accounting record; staff do not interact with cycle terminology.
- Kitchen and receipt printing remain isolated: table order saves send only the kitchen ticket; table payment sends only the receipt; each route has its own printer setting.
- Direct silent printing is used; no PDF download or print dialog is part of the order/payment flow.
