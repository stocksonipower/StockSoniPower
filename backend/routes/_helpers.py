"""Shared bulk-upload / CSV helpers used by stock_master and locations routes.

Extracted from server.py with zero logic changes.
"""
import io
import csv

import pandas as pd
from fastapi import HTTPException, UploadFile
from fastapi.responses import StreamingResponse


def _normalize_col(c: str) -> str:
    return " ".join(str(c).strip().lower().split())


def _csv_response(rows: list, header: list, filename: str) -> StreamingResponse:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(header)
    for r in rows:
        writer.writerow(r)
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


async def _read_file_to_df(file: UploadFile):
    content = await file.read()
    try:
        if file.filename.endswith(".csv"):
            return pd.read_csv(io.BytesIO(content), dtype=str, keep_default_na=False)
        return pd.read_excel(io.BytesIO(content), dtype=str, keep_default_na=False)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"File parse error: {e}")


def _find_col(df, aliases):
    """Return the first column in df that matches any normalized alias."""
    for col in df.columns:
        if _normalize_col(col) in aliases:
            return col
    return None
