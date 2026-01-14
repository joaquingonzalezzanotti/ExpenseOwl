# ExpenseOwl MVP

ExpenseOwl es un tracker de gastos personal, simple y rapido. Esta version es un MVP pensado para uso individual y despliegue estable con Postgres.

## Principios
- Un solo usuario, sin login por ahora.
- Multi-moneda por transaccion (ARS/USD/EUR) sin conversion automatica.
- Graficos y tarjetas principales basadas en la moneda base configurada.
- Persistencia confiable: Postgres obligatorio.

## Storage (Postgres only)
El backend JSON fue deprecado. El codigo historico se guardo en `internal/deprecated` para rollback, pero no se usa en runtime.
Las categorias ahora viven en una tabla dedicada (`categories`) con orden por posicion.

Variables requeridas:
- `STORAGE_TYPE=postgres`
- `STORAGE_URL=host:port/dbname`
- `STORAGE_USER=usuario`
- `STORAGE_PASS=password`
- `STORAGE_SSL=require`

Si falta alguna, la app no inicia.

## Ejecutar local
1) Instalar Go.
2) Exportar variables:
   - Windows (PowerShell):
     ```
     $env:STORAGE_TYPE="postgres"
     $env:STORAGE_URL="host:5432/expenseowl"
     $env:STORAGE_USER="user"
     $env:STORAGE_PASS="pass"
     $env:STORAGE_SSL="require"
     ```
3) Correr:
   ```
   go run ./cmd/expenseowl
   ```
4) Abrir `http://localhost:8080`.

## Deploy (Render/Railway)
- Setear las mismas variables en el servicio.
- Puerto: 8080.
- Build: `go build -o expenseowl ./cmd/expenseowl`
- Start: `./expenseowl`

## Backup / Migracion
- Exportar CSV desde Configuracion.
- Importar CSV para restaurar o migrar.

## Datos basicos
- Expense: name, category, amount, currency, date, tags, source (CA/EFECTIVO/TARJETA), card.

## Tests
Para el test de Postgres:
- `TEST_DATABASE_URL=postgres://user:pass@host:5432/db?sslmode=require`
- `go test ./internal/storage -run TestPostgresStoreCRUD`

## Notas
- JSON storage esta deprecado y no se usa en runtime.
- Monedas soportadas: ARS, USD, EUR.
