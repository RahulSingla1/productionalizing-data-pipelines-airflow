"""Optional: send the kitchen's daily reminders from Airflow instead of the app's built-in scheduler.

Set ENABLE_SCHEDULER=0 on the web app, set the Airflow Variable KITCHEN_APP_DIR to the
cloud-kitchen-app folder (with the same DATABASE and WhatsApp/email settings as the web
app), and drop this file in dags/.
"""
from datetime import datetime, timedelta

from airflow import DAG
from airflow.operators.bash import BashOperator

with DAG(
    dag_id="kitchen_daily_reminders",
    description="Remind kitchen staff to fill in today's sales, expenses and stock",
    start_date=datetime(2026, 1, 1),
    schedule_interval="30 14 * * *",  # 14:30 UTC = 20:00 India time
    catchup=False,
    default_args={"retries": 2, "retry_delay": timedelta(minutes=5)},
    tags=["kitchen"],
) as dag:
    BashOperator(
        task_id="send_reminders",
        bash_command="cd {{ var.value.get('KITCHEN_APP_DIR', '/opt/cloud-kitchen-app') }} && "
                     "ENABLE_SCHEDULER=0 flask --app app send-reminders",
    )
