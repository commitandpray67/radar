import math

from fastapi import APIRouter

from maps.calibration import MAP_CALIBRATIONS

router = APIRouter()


@router.get("/maps")
async def list_maps():
    """Return all known maps with their calibration metadata."""

    def _json_float(v: float) -> float | None:
        return None if math.isinf(v) else v

    result = []
    for name, cal in MAP_CALIBRATIONS.items():
        result.append(
            {
                "name": name,
                "is_multilevel": cal.is_multilevel,
                "layers": (
                    [
                        {
                            "label": la.label,
                            "image": la.image,
                            "z_min": _json_float(la.z_min),
                            "z_max": _json_float(la.z_max),
                        }
                        for la in cal.layers
                    ]
                    if cal.is_multilevel
                    else []
                ),
                "image": cal.image if not cal.is_multilevel else "",
            }
        )
    return result
