import json
import os
from pathlib import Path


def migration_names(paths):
    return sorted(path.name for path in paths if path.suffix == ".sql")


def load_secret(secret_arn, region):
    import boto3

    response = boto3.client("secretsmanager", region_name=region).get_secret_value(
        SecretId=secret_arn,
    )
    return json.loads(response["SecretString"])


def connect(secret):
    import psycopg

    return psycopg.connect(
        host=secret["host"],
        port=secret.get("port", 5432),
        user=secret["username"],
        password=secret["password"],
        dbname=secret.get("dbname", "postgres"),
        connect_timeout=10,
        sslmode="require",
        autocommit=True,
    )


def main():
    directory = Path(os.environ.get("MIGRATIONS_DIR", "/app/migrations"))
    names = migration_names(directory.iterdir())
    secret = load_secret(
        os.environ["DATABASE_SECRET_ARN"],
        os.environ.get("AWS_REGION", "us-east-1"),
    )
    applied = []
    connection = connect(secret)
    with connection:
        with connection.cursor() as cursor:
            cursor.execute("CREATE SCHEMA IF NOT EXISTS agent_market")
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS agent_market.schema_migrations (
                  filename text PRIMARY KEY,
                  applied_at timestamptz NOT NULL DEFAULT now()
                )
                """
            )
            for name in names:
                cursor.execute(
                    "SELECT 1 FROM agent_market.schema_migrations WHERE filename = %s",
                    (name,),
                )
                if cursor.fetchone():
                    continue
                cursor.execute((directory / name).read_text(encoding="utf-8"))
                cursor.execute(
                    "INSERT INTO agent_market.schema_migrations (filename) VALUES (%s)",
                    (name,),
                )
                applied.append(name)
    connection.close()
    print(json.dumps({
        "event": "database.migration.complete",
        "applied": applied,
        "appliedCount": len(applied),
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
