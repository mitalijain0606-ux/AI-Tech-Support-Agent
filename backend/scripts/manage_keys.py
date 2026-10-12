"""Create, list and revoke Operon API keys.

    python scripts/manage_keys.py create --tenant acme --subject alice [--role user] [--label laptop]
    python scripts/manage_keys.py list [--tenant acme]
    python scripts/manage_keys.py revoke <key-id>

`create` prints the token ONCE; only its hash is stored, so a lost token cannot
be recovered, only replaced. Roles: viewer (read only), user (drives and
approves their own sessions), admin (every session of the tenant).
Uses DATABASE_URL like the server does.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from operon_backend.auth import ROLES, create_api_key, revoke_api_key  # noqa: E402
from operon_backend.db import SessionLocal, init_db  # noqa: E402
from operon_backend.db_models import ApiKey  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("create")
    create.add_argument("--tenant", required=True)
    create.add_argument("--subject", required=True)
    create.add_argument("--role", choices=ROLES, default="user")
    create.add_argument("--label")
    listing = sub.add_parser("list")
    listing.add_argument("--tenant")
    revoke = sub.add_parser("revoke")
    revoke.add_argument("key_id")
    args = parser.parse_args(argv)

    init_db()
    db = SessionLocal()
    try:
        if args.command == "create":
            token, row = create_api_key(db, args.tenant, args.subject, args.role, args.label)
            print(f"key id : {row.id}")
            print(f"tenant : {row.tenant_id}   subject: {row.subject}   role: {row.role}")
            print(f"token  : {token}")
            print("Store this token now; it is not shown again.", file=sys.stderr)
        elif args.command == "list":
            query = db.query(ApiKey)
            if args.tenant:
                query = query.filter(ApiKey.tenant_id == args.tenant)
            for row in query.order_by(ApiKey.created_at):
                state = "revoked" if row.revoked_at else "active"
                print(f"{row.id}  {row.key_prefix}…  {row.tenant_id}/{row.subject}  {row.role}  {state}  {row.label or ''}")
        else:
            if not revoke_api_key(db, args.key_id):
                print("No active key with that id.", file=sys.stderr)
                return 1
            print("revoked")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
