MULTIUSER PLAN (MVP) - CONTEXTO Y DECISIONES
============================================

Fecha: 2026-01-28
Proyecto: ExpenseLog

OBJETIVO
--------
Convertir la app a multiusuario con autenticacion por email/password.
Cada usuario ve solo sus propios datos (multi-tenant privado).

DECISIONES DE NEGOCIO (PO)
--------------------------
- Multiusuario privado: cada usuario ve lo suyo.
- Sin grupos/familias.
- Sin roles (todos editan igual).
- MVP libre (sin planes).
- Auto registro con email/password.
- Google OAuth: despues (no en MVP).
- Verificacion de email: despues (post-MVP).
- Recuperar contrasena: si, via codigo por email (Sprint 3).
- Recordar sesion: si es posible (cookie con expiracion larga).
- Bloqueo de pantallas: todas las pantallas requieren sesion.
- Multi-moneda: por usuario (config individual).
- Exportacion/auditoria: no ahora, pero disenar pensando en futuro.
- Borrado/inactividad de cuentas: no definido aun.
- Hosting: PaaS, probable Fly.io (Render lento, Railway fallo por volumen).
- BD: usar la actual y migrar datos existentes al usuario del owner.
- Owner inicial: email joaquingzzz79@gmail.com, password admin2008 (guardar hash).
- Politica de password: minimo 8 caracteres.

ARQUITECTURA (MVP)
-----------------
Auth:
- Email + password con hash seguro (bcrypt/argon2).
- Sesiones por cookie HTTP-only.
- "Recordarme": sesion con expiracion mas larga.

Multi-tenant:
- Cada tabla principal tiene user_id.
- Todas las queries filtran por user_id desde middleware.

Config por usuario:
- Opcion elegida: NUEVA tabla user_config.
- Cada usuario tiene su moneda, fecha inicio, y categorias propias.

Datos existentes:
- Migracion: crear usuario owner y asignar user_id a todos los registros actuales.

TABLAS PROPUESTAS
-----------------
users:
- id (uuid)
- email (unique)
- password_hash
- created_at
- status

sessions:
- id (uuid/token)
- user_id
- expires_at
- created_at
- ip
- user_agent

user_config:
- user_id (unique)
- currency
- start_date

Tablas a extender con user_id:
- expenses
- recurring_expenses
- categories

ENDPOINTS (MVP)
--------------
Auth:
- POST /auth/register
- POST /auth/login
- POST /auth/logout
- GET /auth/me

Core:
- Todos los endpoints existentes, filtrados por user_id.

SPRINTS
-------
Sprint 0 (definicion)
- Confirmar PaaS (Fly.io u otro).
- Definir proveedor de email para reset (Resend/Postmark/SendGrid).
- Confirmar si se migra la BD actual (decidido: SI, al owner).

Sprint 1 (DB + backend core)
- Migraciones: users, sessions, user_config.
- Agregar user_id a tablas core.
- Middleware de auth (cookie session).
- Storage: todas las queries con user_id.
- Backfill de user_id con owner.

Sprint 2 (UI + flujo auth)
- Pantallas login/registro.
- Bloqueo total sin sesion.
- "Recordarme".

Sprint 3 (reset password + hardening)
- Reset de password via codigo por email.
- Rate limit basico en login.
- (Opcional) verificacion de email.

Sprint 4 (futuro)
- OAuth Google.
- Exportacion CSV/JSON.
- Auditoria/historial.

NOTAS TECNICAS
--------------
- HTTPS obligatorio para cookies seguras.
- Evitar JWT en front (preferir cookie HTTP-only).
- Diseñar pensando en exportacion futura (sin implementarla ahora).
- Bootstrap usuario: variables BOOTSTRAP_EMAIL y BOOTSTRAP_PASSWORD (si no existen, usa los defaults).
