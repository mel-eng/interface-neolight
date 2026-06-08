from openpyxl import load_workbook
from pathlib import Path

# ============================
#   RUTAS BASE DEL PROYECTO
# ============================

# Este archivo está en: server/excel/generar_excel.py
# Subimos dos niveles para llegar a /server
BASE_DIR = Path(__file__).resolve().parent.parent

# Plantilla original en /server (NO se toca)
TEMPLATE_PATH = BASE_DIR / "Plantilla_Fototerapia_Neonatal.xlsx"

# Carpeta donde se guardarán los reportes generados
OUTPUT_DIR = BASE_DIR / "reportes"
OUTPUT_DIR.mkdir(exist_ok=True)  # crea /server/reportes si no existe


def generar_reporte_paciente(datos_paciente, sesiones, alarmas):
    """
    Genera un archivo Excel SIN modificar la plantilla original.
    Guarda el resultado en /server/reportes/Reporte_<id>.xlsx
    """

    # Nombre del archivo de salida (siempre distinto a la plantilla)
    nombre_archivo = f"Reporte_{datos_paciente['id_paciente']}.xlsx"
    ruta_salida = OUTPUT_DIR / nombre_archivo

    # Cargar SIEMPRE la plantilla original
    wb = load_workbook(TEMPLATE_PATH)

    ws1 = wb["Hoja de Vida del Paciente"]
    ws2 = wb["Historial de Terapia"]
    ws3 = wb["Alarmas y Eventos"]

    # ============================
    #   HOJA 1: DATOS DEL PACIENTE
    # ============================
    # OJO: en tu plantilla los datos van en D13..D20 (celdas combinadas D13:G13, etc.)
    ws1["D13"] = datos_paciente["id_paciente"]      # ID Paciente
    ws1["D14"] = datos_paciente["nombre"]           # Nombre Completo
    ws1["D15"] = datos_paciente["fecha_nac"]        # Fecha de Nacimiento
    ws1["D16"] = datos_paciente["edad_dias"]        # Edad (días)
    ws1["D17"] = datos_paciente["doctor"]           # Doctor a Cargo
    ws1["D18"] = datos_paciente["diagnostico"]      # Diagnóstico
    ws1["D19"] = datos_paciente["contacto"]         # Contacto de Emergencia
    ws1["D20"] = datos_paciente.get("obs", "")      # Observaciones Médicas

    # ============================
    #   HOJA 2: HISTORIAL TERAPIA
    # ============================
    fila = 7  # en tu diseño las filas de datos empiezan en la 7
    for s in sesiones:
        ws2[f"B{fila}"] = s["fecha"]
        ws2[f"C{fila}"] = s["hora_inicio"]
        ws2[f"D{fila}"] = s["hora_fin"]
        ws2[f"E{fila}"] = s["id_sesion"]
        ws2[f"F{fila}"] = s["modo"]
        ws2[f"G{fila}"] = s["duracion_min"]
        ws2[f"H{fila}"] = s["tiempo_rango_min"]
        ws2[f"I{fila}"] = s["led_promedio"]
        ws2[f"J{fila}"] = s.get("obs", "")
        fila += 1

    # ============================
    #   HOJA 3: ALARMAS Y EVENTOS
    # ============================
    fila = 7
    for a in alarmas:
        ws3[f"B{fila}"] = a["fecha"]
        ws3[f"C{fila}"] = a["hora"]
        ws3[f"D{fila}"] = a["id_sesion"]
        ws3[f"E{fila}"] = a["tipo"]
        ws3[f"F{fila}"] = a["valor"]
        ws3[f"G{fila}"] = a["duracion_s"]
        ws3[f"H{fila}"] = a.get("accion", "")
        fila += 1

    # ============================
    #   GUARDAR REPORTE FINAL
    # ============================
    wb.save(ruta_salida)
    print(f"Reporte generado correctamente en:\n{ruta_salida}")


# ========== PRUEBA LOCAL ==========
if __name__ == "__main__":
    datos = {
        "id_paciente": "NEO_001",
        "nombre": "Bebé Demo",
        "fecha_nac": "2025-11-30",
        "edad_dias": 3,
        "doctor": "Dra. X",
        "diagnostico": "Ictericia neonatal",
        "contacto": "+591 70000000",
        "obs": "Solo prueba local",
    }

    sesiones = [
        {
            "fecha": "2025-11-30",
            "hora_inicio": "10:00",
            "hora_fin": "10:40",
            "id_sesion": "S001",
            "modo": "Automático",
            "duracion_min": 40,
            "tiempo_rango_min": 35,
            "led_promedio": 80,
            "obs": "OK",
        }
    ]

    alarmas = [
        {
            "fecha": "2025-11-30",
            "hora": "10:15",
            "id_sesion": "S001",
            "tipo": "Distancia baja",
            "valor": "27 cm",
            "duracion_s": 10,
            "accion": "Se elevó lámpara",
        }
    ]

    generar_reporte_paciente(datos, sesiones, alarmas)
