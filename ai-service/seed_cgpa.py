"""Add fictional CGPA values to existing @example.test student accounts."""

import time

from auth import connect_database


DEMO_CGPAS = (8.4, 6.7, 9.2, 7.5, 8.8, 6.2)


def main():
    now = int(time.time())
    with connect_database() as connection:
        connection.execute(
            """CREATE TABLE IF NOT EXISTS student_academic_profiles (
                student_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                cgpa REAL NOT NULL,
                cgpa_scale REAL NOT NULL,
                updated_at INTEGER NOT NULL
            )"""
        )
        students = connection.execute(
            "SELECT id, email FROM users WHERE role = 'student' AND email LIKE '%@example.test' COLLATE NOCASE ORDER BY id"
        ).fetchall()
        for index, student in enumerate(students):
            connection.execute(
                """INSERT INTO student_academic_profiles (student_id, cgpa, cgpa_scale, updated_at)
                   VALUES (?, ?, 10, ?)
                   ON CONFLICT(student_id) DO UPDATE SET cgpa = excluded.cgpa,
                     cgpa_scale = excluded.cgpa_scale, updated_at = excluded.updated_at""",
                (student["id"], DEMO_CGPAS[index % len(DEMO_CGPAS)], now),
            )

    if not students:
        print("No @example.test student accounts found. Create a fictional student account, then run this script again.")
        return
    print("Seeded fictional CGPA records (scale 10) for these demo student accounts:")
    for index, student in enumerate(students):
        print(f"  {student['email']}: {DEMO_CGPAS[index % len(DEMO_CGPAS)]}/10")
    print("These values are dummy data. Replace them with college-provided records before real use.")


if __name__ == "__main__":
    main()
