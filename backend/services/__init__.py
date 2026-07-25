"""Service layer — Stock In business orchestration.

Services own the business rules and coordinate repositories inside a single
unit of work, so a whole operation (e.g. "record a racking note") either fully
commits or fully rolls back.
"""
