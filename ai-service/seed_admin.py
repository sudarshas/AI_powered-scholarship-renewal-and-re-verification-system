import getpass
import sqlite3
import sys

from fastapi import HTTPException

from auth import create_admin_account


def main():
    email = sys.argv[1] if len(sys.argv) > 1 else input("Admin email: ").strip()
    password = getpass.getpass("Admin password (12 characters minimum): ")
    confirmation = getpass.getpass("Confirm admin password: ")
    if password != confirmation:
        raise SystemExit("Passwords do not match")
    try:
        account = create_admin_account(email, password)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    except HTTPException as error:
        raise SystemExit(error.detail) from error
    except sqlite3.IntegrityError as error:
        raise SystemExit("An account with that email already exists") from error
    print(f"Created demo admin account for {account['email']} (id {account['id']}).")


if __name__ == "__main__":
    main()
