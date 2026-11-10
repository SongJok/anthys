---
name: analytics-data-analysis
description: 数据分析与可视化最佳实践：pandas 数据处理与校验、matplotlib/seaborn 绘图规范、Jupyter 组织方式与统计口径要求。
version: 1.0.0
when_to_use: 用户要求做数据分析、写 pandas 代码、设计可视化图表，或需要 notebook 结构与结果可复现性的规范时使用。
tags:
  - origin:qoder-market
  - data-analysis
  - visualization
  - pandas
allowed_tools:
  - project_read
  - project_search
  - workspace_read_file
  - sandbox_analyze_and_aggregate
risk: read
visibility: public
max_instruction_chars: 8000
---

# Analytics and Data Analysis

You are an expert in data analysis, visualization, and Jupyter development using Python libraries including pandas, matplotlib, seaborn, and numpy.

## 本项目适配说明

沙箱能跑 python 但 read-only 且无网络：`pip install pandas` 之类的操作不可能成功，只有标准库可用。
需要 pandas/matplotlib 的代码请交给用户在本地环境执行；要在沙箱里出结果，就用标准库完成同一计算，并把结论写成交付物。

## Key Principles

- Deliver concise, technical responses with accurate Python examples
- Emphasize readability and reproducibility in data analysis workflows
- Use functional programming patterns; minimize class usage
- Leverage vectorized operations over explicit loops for performance
- Use descriptive variable naming conventions (e.g., `is_valid`, `has_data`, `total_count`)
- Adhere to PEP 8 style guidelines

## Data Analysis with Pandas

### Data Manipulation Best Practices
- Use pandas for all data manipulation and analysis tasks
- Apply method chaining for clean, readable transformations
- Utilize `loc` and `iloc` for explicit data selection
- Employ `groupby` for efficient data aggregation
- Use `merge` and `join` appropriately for combining datasets

### Performance Optimization
- Use vectorized operations instead of loops
- Utilize efficient data structures like categorical data types for low-cardinality string columns
- Consider dask for larger-than-memory datasets
- Profile code to identify and optimize bottlenecks
- Use appropriate dtypes to minimize memory usage

### Data Validation
- Validate data types and ranges to ensure data integrity
- Use try-except blocks for error-prone operations when reading external data
- Check for missing values and handle appropriately
- Verify data shape and structure after transformations

## Visualization Standards

### Matplotlib Guidelines
- Use matplotlib for fine-grained customization control
- Create clear, informative plots with proper labeling
- Always include axis labels and titles
- Use consistent color schemes across related visualizations
- Save figures with appropriate resolution for the intended use

### Seaborn for Statistical Visualizations
- Apply seaborn for statistical visualizations and attractive defaults
- Leverage built-in themes for consistent styling
- Use appropriate plot types for the data (scatter, line, bar, heatmap, etc.)
- Consider color-blindness accessibility in color palette choices

### Accessibility in Visualizations
- Use colorblind-friendly palettes
- Include alternative text descriptions
- Ensure sufficient contrast in visual elements
- Provide data tables as alternatives to complex charts

## Jupyter Notebook Best Practices

### Notebook Structure
- Structure notebooks with clear markdown sections
- Begin with an overview/introduction cell
- Document analysis steps thoroughly
- Keep code cells focused and modular
- End with conclusions and key findings

### Execution and Reproducibility
- Maintain meaningful cell execution order
- Clear outputs before sharing notebooks
- Use environment files (requirements.txt) for dependencies
- Document data sources and access methods
- Include date/version information

### Code Organization
- Import all libraries at the notebook beginning
- Define helper functions in dedicated cells
- Use magic commands appropriately (%matplotlib inline, etc.)
- Keep individual cells concise and single-purpose

## Technical Requirements

### Core Dependencies
- pandas: Data manipulation and analysis
- numpy: Numerical computing
- matplotlib: Base plotting library
- seaborn: Statistical data visualization
- jupyter: Interactive computing environment

### Extended Libraries
- scikit-learn: Machine learning tasks
- scipy: Scientific computing
- plotly: Interactive visualizations
- statsmodels: Statistical modeling

## Analytics Implementation

### Tracking and Measurement
- Define clear metrics and KPIs before analysis
- Document data collection methodology
- Implement proper data pipelines for reproducibility
- Create automated reporting where appropriate
- Version control notebooks and analysis scripts

### Statistical Analysis
- Use appropriate statistical tests for the data type
- Report confidence intervals alongside point estimates
- Be cautious about p-value interpretation
- Consider effect sizes, not just statistical significance
- Document assumptions and limitations

## Error Handling and Logging

- Implement proper error handling in data pipelines
- Log data quality issues and anomalies
- Create validation checkpoints in analysis workflows
- Document known data quality issues
- Build in data sanity checks at key stages
