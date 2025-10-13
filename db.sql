-- Placas (camiones)
CREATE TABLE IF NOT EXISTS trucks (
  placa VARCHAR(32) PRIMARY KEY,
  unidad VARCHAR(64) NULL,
  cedis  VARCHAR(64) NULL,
  marca  VARCHAR(64) NULL,
  modelo VARCHAR(64) NULL,
  anio   VARCHAR(16) NULL,
  vin    VARCHAR(64) NULL,
  telefono_quejas VARCHAR(64) NULL,
  foto   VARCHAR(512) NULL,
  notas  TEXT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Documentos / permisos
CREATE TABLE IF NOT EXISTS documents (
  id VARCHAR(32) PRIMARY KEY,
  placa VARCHAR(32) NOT NULL,
  categoria VARCHAR(64) NOT NULL,
  titulo VARCHAR(128) NOT NULL,
  fecha_vencimiento DATE NULL,
  url VARCHAR(512) NULL,
  alert22Sent TINYINT(1) NOT NULL DEFAULT 0,
  CONSTRAINT fk_documents_truck FOREIGN KEY (placa)
    REFERENCES trucks(placa) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Reportes públicos
CREATE TABLE IF NOT EXISTS reports (
  id VARCHAR(32) PRIMARY KEY,
  placa VARCHAR(32) NOT NULL,
  tipo VARCHAR(32) NOT NULL,
  nombre VARCHAR(128) NULL,
  telefono VARCHAR(64) NULL,
  email VARCHAR(128) NULL,
  mensaje TEXT NOT NULL,
  createdAt DATETIME NOT NULL,
  INDEX idx_reports_placa_created (placa, createdAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
